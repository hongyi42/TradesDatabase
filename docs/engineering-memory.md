# Engineering memory — the knowledge that isn't in the code

**What this is:** the institutional memory of this project, written down for anyone who works on
the repo. Until 2026-07-20 most of this lived only in the operator's private Claude-session
memory; a new engineer would hit these walls blind. Facts are stamped with dates — treat every
"current state" claim as a snapshot, and update this file when reality changes.

**Reading order for a new engineer:**
[Three-Layer-Context-Spine-Overview.md](Three-Layer-Context-Spine-Overview.md) (what we're
building) → `CLAUDE.md` at the repo root (hard rules) → this file (everything in between) →
the runbooks ([doorman-runbook.md](doorman-runbook.md), [control-plane.md](control-plane.md),
[nemoclaw-tech-agent.md](nemoclaw-tech-agent.md), `Box_Setup_Stuff/`).

---

## 1. How we work (process rules)

- **Every code change goes through a PR before `main`** (standing rule, 2026-07-12). Direct
  push only on an explicit per-change waiver. "You may commit" authorizes a commit, **not** a
  push. **Doc-only carve-out (2026-07-13):** markdown-only diffs (`docs/`, `thoughts/`,
  READMEs) skip the PR — commit on `main` locally, the owner pushes.
- **RPI workflow** (research → plan → implement) for non-trivial features; the plan is the
  human-review gate. Two concurrent features: plan both first, compare footprints. Details in
  `CLAUDE.md`.
- **`Box_Setup_Stuff/` is not documentation — it's the only context a host-side Claude gets**
  when bootstrapping/maintaining trades-box-1. It cannot see this repo. So: (a) any
  architectural change to the agent stack must update `Box_Setup_Stuff/` in the same change;
  (b) those files must be self-contained — never "see docs/X §N", always inline the fact.
- **Verify vendor claims against live docs, cite URLs** (`CLAUDE.md` has the rule and the
  Composio case study).
- **Never paste badge plaintext anywhere** (chat, docs, commits). A 2026-07-03 leak forced
  rotating every badge. Fingerprints (sha256) only.

## 2. Product principles (user decisions — don't re-litigate, do cite when relevant)

- **Telegram is the entire UI** (2026-07-03). No web front end exists or is planned. Managers
  and technicians do everything through their Telegram agent chat; the Telegram **Mini App
  dispatch board** (2026-07-14) is the one recorded, deliberate extension. **Evolved
  2026-07-23 (user decision):** the board is no longer view-only-plus-gestures — it is *the
  manager's hands* for quick direct edits (a manager already in the Mini App won't exit to
  chat and come back); the agent's role is **autonomy + recommendation** (propose/solve/
  confirm/nudge). Non-negotiable guardrail: every board gesture calls the same
  `src/schedule/booking.ts` verbs as chat — one write path, one promise-ladder gate, never a
  parallel editing logic. Operators (us) appear only at initial setup and breakage; anything
  else operator-side is debt to automate.
- **Vocabulary must track what actually gates** (2026-07-23, PR #74). `assignments.locked`
  marks a manual placement for the *future* auto-scheduler (Plan 4b) to route around — every
  manual book/move stamps it true, so a "locked" badge appeared on every visit and read as
  "this time can't change" (false: no-promise visits move freely, one-shot). The badge is
  gone; the **promise ladder** is the human-facing constraint vocabulary. Don't surface
  solver-internal flags to humans until the solver exists; when 4b lands, `locked` can
  resurface as "pinned — won't be auto-moved".
- **Two access tiers, `manager` and `technician`** (2026-07-02/04). Technician = broad
  non-manager catch-all (field techs, office, sales). Manager seats price higher and get the
  **entire Composio catalog + self-serve pairing** (risk accepted deliberately — no structural
  block, disclosure + confirmation instead). Technicians get a curated tool list; technician
  email sends go through the spine's two-step `send_email`, never `GMAIL_SEND_EMAIL`.
  Enforcement point = per-person Composio **session** configs (execution-enforced, verified:
  HTTP 400 code `4310`, not 403) + doorman badge tier for spine tools.
- **Seat-based licensing** (2026-07-02): a firm buys N seats; adding a person needs a free
  seat (structural server-side cap, never trusted to the agent). All purchased seats'
  sandboxes are **pre-built cold** (hardware up, identity empty). Seats are reusable;
  **technician refs are permanent and never reused across humans** (L1 is append-only).
  Pool invariant: free blanks = purchased seats − active members. The only un-automatable
  step is creating Telegram bots at BotFather (no API) — pre-create and vault tokens.
- **Spine scope boundary** (2026-07-06): the spine is the **customer/job record**, not a
  mirror of every connector. Connector-side data (a manager's Excel, etc.) keeps its own
  ground truth; manual-edit invisibility there is an accepted characteristic. Durable pattern:
  "spine originates, sheet displays". L2 stays fixed in v1; L3 (JSONB `attributes`) is the
  elastic layer; a fact graduates to a real table only when someone needs to query across it.
- **Confirmation doctrine** (ratified 2026-07-17, live since PR #48): *"confirm only what's
  irreversible or externally visible; everything reversible, just do — and say what you did."*
  The promise ladder (`promise_level none/day/time/time_only` — fourth level 2026-07-23: told a TIME but not the day; the time gates, the day moves freely) is the marker for "externally visible".
  Over-confirming is a **safety** problem (trains rubber-stamping). Single-sourced as
  `requiresConfirmation` on tool previews in `src/schedule/booking.ts` — new surfaces inherit
  it, never re-derive. Corollaries: never confirm a default the bot itself chose (apply, state
  it, let them change it); no unprompted permanence lectures; when a structural guard ships,
  retire the prompt-layer duplicate in the same change.
- **REJECTED direction — do not propose again:** server-authored verbatim sentences for
  agent-facing wording (PRs #44/#45 closed unmerged, 2026-07-15). The user chose AI agents
  precisely because they navigate messy conversations; fix *input* paths with mechanisms
  (e.g. the `resolve_date` tool) instead of muzzling the agent's voice.
- **Agent model:** the GLM line is a standing decision (Nemotron-3 was "too dumb" — never
  restore it while debugging). Current: **GLM-5.2 via DeepInfra** (`zai-org/GLM-5.2`), NVIDIA
  `nvidia-prod` (`z-ai/glm-5.2`) as automatic failover ("medic v2", 5-min timer on the box).

## 3. Environments & infrastructure

```
 Manager / technician phones
      │ Telegram DMs (one bot per person)         Telegram Mini App (board)
      ▼                                                    ▼
 trades-box-1 — AWS Lightsail, static IP 34.211.61.184, `ssh tradesbox`
   per-person OpenClaw sandboxes (s2, s3, s5, …)
      │  each sandbox holds ONE revocable badge — no real secrets ever
      ▼
   doorman (host process, outside the sandboxes; badge → identity)
      │  HTTPS + HMAC identity headers (x-tenant-id / x-technician-ref)
      ▼
 Render (tradesdatabase.onrender.com)
   ├─ spine MCP server (src/mcp/server.ts) ──► Supabase "test" = PILOT LIVE DB
   ├─ /composio relay ──► per-person Composio session (Gmail, Sheets, …)
   ├─ board web + background worker (global bot @DashboardMan_bot)
   └─ cron heartbeat (badge lifecycle, pairing sweep, grace expiry)
 Inference: sandbox gateway ──► DeepInfra GLM-5.2 (failover: NVIDIA)
```

**Three Supabase environments** (full detail: the test rules in `CLAUDE.md`):

| Env | Ref | Reality |
|---|---|---|
| `supabase-prod` (MCP) | `lzlgysoydhknsdvovntz` | **Empty** factory-fresh project (verified 2026-07-06), read-only, auto-pauses (~60s wake). Not real data. |
| `supabase-test` (MCP) | `daqapdlkgxfrhquacprv` | **Despite the name: the deployed pilot's LIVE database.** Render + the box read it. SELECT read-backs fine; never test writes. Its `raw_captures` holds real mail — unrecoverable. |
| Local Docker stack | `npx supabase start` | The **only** writable test env. `npm test` is hard-pinned to it (`src/testEnvGuard.ts`). |

**Deploy/migration gotchas (each one burned us):**
- Render's **"Redeploy" button re-runs the OLD commit** — use "deploy latest commit" and
  confirm the **live commit hash** in the dashboard. Two E2E attempts once failed on stale
  server code this way.
- **Nothing auto-applies DB migrations to the pilot.** Render only builds+starts.
  `npm run db:push` is unreliable here — the pilot's migration ledger has drifted from the
  repo (versions applied that no repo file carries). Use the Supabase MCP `apply_migration`
  for pilot DDL. Ledger reconciliation = open tech debt.
- **Deploy-before-migration** fails safe but noisily (PostgREST "unknown column" on the new
  code path; fix = apply migration + `NOTIFY pgrst, 'reload schema'`). Happened live
  2026-07-19 (seat-exempt); the two-step confirm flow protected the pilot.
- PostgREST silently caps result sets at **1000 rows** (`db-max-rows`) — any scan that can
  exceed it must paginate (see `src/db/foldImpact.ts` for the pattern).
- `googleapis` stays in package.json even though the schedule sheet is retired —
  `src/email/ingest.ts` imports it.
- Schedule times are stored **naive-local** (wall-clock written as-if-UTC) — deliberate
  (see [thoughts/shared/plans/2026-07-14-schedule-core-on-assignments.md](../thoughts/shared/plans/2026-07-14-schedule-core-on-assignments.md)).
  Availability checks pass timezone `'UTC'`. Revisit if a tenant spans timezones.
- `rescheduleAssignment` creates the new row as `'proposed'` by default while every reader
  filters `['confirmed']` — moves MUST pass `status:'confirmed'`.

## 4. Live-state snapshot (as of 2026-07-22 — verify before relying)

**Tenants on the pilot DB:**
- "Default Tenant" `82bbc6f8…` — demo/seed data; the user tests as `manager-sam`.
- "Judy Testing" `ee65b342-24b3-4f26-bc23-0e2e30627e1d` — **first real external beta**
  (onboarded 2026-07-07; a friend of the owner, manager tier, 1 manager + 3 tech seats).
  Gmail paired (2026-07-19). Still owed: a phone E2E check-in and a heads-up about one-shot
  bookings + the dispatch board. **Never hand-touch her sandbox (s3).**

**Sandbox map on trades-box-1** (pre-pool legacy sandboxes' bot handles are NOT in the DB —
identify by which chat answers):

| Sandbox | Person | Notes |
|---|---|---|
| s2 | manager-sam (the owner, TG 5801703167) | main manager test bot |
| s3 | judy-testing | real beta — hands off. Roster TG is NULL (no phone bound yet); the sandbox allowlist currently holds 8991633730 (ben-shelton's id — drift): correct it when Judy binds or she's locked out |
| s5 | ben-shelton, invited technician (@ragisan03_bot, TG 8991633730) | |
| s6 | COLD BLANK (@ragisan2_bot) | the pool's one free blank (from s1's recycle) |
| s7 | Yutao (manager, active, Default Tenant, TG 8639645984) | the box's DEFAULT sandbox; NOT in `sandbox_pool` (provisioned outside the pool, like pre-pool s2/s3) |
| s8 | manager-joy (Joy, manager, active, Default Tenant, TG 8816690083) | onboarded 2026-07-24; onboarded config says deepinfra-prod but the LIVE gateway runs nvidia-prod — the config-applying restart died mid-flight and left a stale shields-transition lock (see ops trap below); as of 2026-07-25 the gateway has NOT been restarted since the #79/#80 tool-vocabulary deploy, so her bot may advertise the stale pre-rename tool list |
| s1, s4 | retired/recycled | historical only |

**Board:** one global non-AI bot `@DashboardMan_bot` (plain code on Render; tenant isolation
comes from the roster lookup of the verified Telegram user id, not the bot).
`BOARD_PUBLIC_URL` has **no** `/board` suffix — the worker appends it.

**Feature status:**
- **Live:** spine + note lifecycle + retractions with fold-impact preview; technicians table +
  seat management + control-plane lifecycle; Feature A (manager binds a technician's Telegram
  from chat, pool claim + badge pull); schedule core (Plan 1, PR #43 + promise-default fix);
  dispatch board (Plan 2, PR #50/#52/#55/#57/#60/#61); confirmation doctrine (PR #48);
  required start+end times (PR #53); manager schedule reads = `get_team_schedule` only
  (PR #54); seat-exempt schedulable person (PR #58); board link on every schedule answer
  (PR #59, merged 2026-07-20 — **post-merge box rollout still unverified**: wire re-run
  s2/s3/s5 + gateway restarts + live "what's the schedule" re-test); scheduling-inputs schema
  groundwork — technician skills + job priority homes (PR #62, merged 2026-07-20);
  Plans 3a+3b (schedule input verbs + `find_slots`); Plan 4a + 4a.5/4a.6 (loose-bucket tray +
  board quick-edit + polish); **cancel vocabulary (PR #80) + duration ladder 4b-1 (PR #79),
  both merged+deployed 2026-07-25** — served board.js byte-verified against main; gateways
  s2/s3/s5/s7 restarted (s8 blocked on the stale-lock trap below); live probes on s2 passed:
  `find_slots` fail-closed → set length 90 → SQL read-back → candidates from the job's own
  length; `unschedule_visit` → "work isn't cancelled … back in the loose bucket" + assignment
  `cancelled`/job `open`; `cancel_job` → two-step demanded, visit cascade, terminal `cancelled`,
  ledger triple (`booked`/`cancelled`+`jobCancellation`/`job_cancelled`); minted-shell
  `duration_minutes` recorded (60). Telegram-path doctrine + board device checks remain the
  owner's pass (CLI probes can't judge AGENTS.md-dependent behavior).
  Doctrine from the Plan-3 reshape stands: **no monolithic auto-scheduler; agency stays in the
  agent, tools measure** (research: `thoughts/shared/research/2026-07-20-flexible-scheduling-agent-toolset.md`).
- **Deferred / backlog (each has an owner-stated reason — check before resurrecting):**
  `reflow_day` batch cascade (3c); ROI/whole-plan optimization → Plan 4's freeze; jargon
  leaking into chat (conflict #1 — fix must NOT be verbatim templates); Sat/Sun "next week"
  boundary warning on `resolve_date` results; agent latency (~84s serial GLM round-trips);
  Feature C (per-tenant agent memory layer); Feature D (customer/job-level L3 write path);
  Telegram unbind/offboarding (apply path is additive-only); board-auth 401 logging (PR #51
  closed unmerged — debug future 401s with the "mint-a-slip" probe: sign a fake initData slip
  with the real bot token from `.env` against the live API to discriminate server-token vs
  Telegram-side).
- **In trial (2026-07-20, s2 ONLY):** inference cost — `compat.supportsPromptCacheKey: true`
  set in s2's rendered `openclaw.json` (backup `openclaw.json.bak-cachekey-20260720` beside it;
  `.config-hash` regenerated; gateway restarted, health passed). Makes OpenClaw forward a
  session-scoped `prompt_cache_key` to DeepInfra to raise the prompt-cache hit rate (~25%
  baseline: 9.9M cached tokens on $30 usage, input:output ≈230:1). Outcome measure = DeepInfra
  dashboard cached-token share over the following days. GLM-5.2 stays (owner decision — Nemotron
  quality experience rules out smaller/"flash"-tier models). **Trap:** any s2 rebuild/re-onboard
  re-renders the config and silently drops the flag (same drift class the inference medic guards);
  if the trial wins, mirror the flag into the render source + all sandboxes. Full mechanics,
  revert recipe, and citations:
  [thoughts/shared/research/2026-07-20-glm52-deepinfra-cache-optimization.md](../thoughts/shared/research/2026-07-20-glm52-deepinfra-cache-optimization.md).
- **Dated debts:** GRANT/default-privileges migration to replace
  `auto_expose_new_tables = true` — **due before 2026-10-30** (Supabase removes the flag;
  fresh local stacks then break with `permission denied`). Old revoked NVIDIA key may still
  sit in `/root/s4-nvidia.env` on the box — refresh before the next `provision` run. Render
  `ANTHROPIC_API_KEY` was found invalid 2026-07-04 (write-path spine tools fail) — verify it
  was fixed.
- **Pending human tests:** Ben's phone board test (read-only day view, no tab bar, push on
  move); promised-visit confirm dialog via board drag; Judy items above.

## 5. The walls — traps by the time you'd hit them

The box-side details live in `Box_Setup_Stuff/` (setup guide §8 gotchas, architecture-memory
"Gotchas") — this is the index of what exists, so you know to go look.

**Working on the agent boxes:**
- **Credentials inject into a sandbox's process env at container launch ONLY.** Any provider
  credential write (badge install/rotation, token change) needs a container restart to take
  effect. This exact mechanism silently killed Judy's spine MCP for 4 days (badge in store,
  absent from env).
- **`nemoclaw rebuild` can destroy the sandbox's device private key** (vendor bug: the
  state-snapshot sanitizer replaces `privateKeyPem` with `[STRIPPED_BY_MIGRATION]` in the
  LIVE identity). Symptom: endless device-pairing loop, no Telegram polling, no MCP. Detect:
  `grep STRIPPED_BY_MIGRATION .../identity/device.json`. Back up identity files around any
  rebuild; prefer `gateway restart` (safe) over rebuild wherever possible.
- **The placeholder versioning trap:** the stock start script freezes credential placeholders
  to a versioned form; a later provider write strands them → dead Telegram bridge after
  restart. The boot self-heal never runs on the new-generation stack. After any provider
  credential write, confirm placeholder forms are canonical before restarting agents.
- **`nemoclaw onboard`/rebuild resets the gateway inference route** to the NVIDIA free-tier
  default (rate-limited, wrong model). The medic timer re-asserts DeepInfra within 5 min; if
  agents act "dumb"/throttled right after an onboard, that's why.
- **There is NO per-tool allowlist file** in the sandbox configs, whatever older docs imply.
  "Pinning" = the gateway's cached MCP `tools/list` (refresh: `nemoclaw <s> gateway restart`;
  MCP starts lazily, so verify behaviorally — logs stay quiet) + the AGENTS.md contract
  lines. **MCP tool descriptions are fetched once per process** — after deploying description
  changes, restart the relevant sandbox containers.
- **The Telegram sender allowlist lives in TWO places** (rendered `openclaw.json` +
  `.config-hash`, and source `sandboxes.json` `allowedIds`) — a durable change writes both,
  then `gateway restart`. `channels status --json` shows drift. File perms must be 660.
- **Never health-check via `nemoclaw <s> agent`** — it injects into the person's LIVE
  Telegram conversation. Use `doctor`, `channels status`, logs, or a live message from an
  authorized phone.
- **Trust box evidence over vendor status pages** (DeepInfra stayed green through two real
  outages). Both-providers-dead alarm → check the DeepInfra balance (HTTP 402) first.
- **A deactivated seat's bot goes silent but alive** — deactivation revokes the *badge*
  (instantly — doorman re-reads badges.json per request), not the container or Telegram bot.
  A "zombie chat" answers small talk but every spine call 403s, until recycled. Related mask:
  sandboxes have OpenClaw's native `web.fetch` enabled, so a bot with a dead spine MCP can
  still "answer things" — don't let that fool a diagnosis.
- **Don't verify badges by extracting them from `/proc/<pid>/environ`** — that method
  produced false 403s (never diagnosed). Use the runbook's minted-badge gate or a live agent
  call.
- Small but sharp: non-interactive ssh lacks `nemoclaw` on PATH
  (`export PATH=$HOME/.local/bin:$PATH`); `nemoclaw upload` writes 640 but the gateway needs
  660 (`doctor --fix`); `nemoclaw exec` eats stdin in heredocs (`</dev/null`).
- **A crashed `gateway restart` leaves a stale shields-transition lock that blocks every later
  restart** (observed 2026-07-25 on s8, from a restart that died 07-24): the next restart waits
  30s then aborts with "Timed out … waiting for shields transition lock … recorded owner PID
  <n> is not running". NemoClaw refuses to clear it itself; the fix is exactly what the error
  says — confirm the owner PID is dead and no transition process is running (`ps`), then remove
  `~/.nemoclaw/state/shields-transition-lock-<s>.json` on the box and retry. Side effect of the
  original crash: the sandbox keeps running its PRE-restart config (s8 showed
  "live gateway differs from onboarded" drift for a full day).
- **CLI chat probes run on the EMBEDDED agent, not the gateway** (observed 2026-07-23,
  4a.5 detach probe): `nemoclaw <s> agent --agent main --session-id <fresh> -m "…"` gets
  "gateway closed (1008): pairing required" (the box CLI device isn't gateway-paired) and
  falls back to an embedded agent reading the same `openclaw.json` — so a CLI probe DOES
  exercise deployed Render code + doorman + badge + real tool choice, but NOT the gateway's
  cached tools/list, and it TRUNCATES AGENTS.md at 12,000 chars (`[agent/embedded] …
  truncating`) — never judge AGENTS.md-dependent behavior (board-link lines, batching,
  contract parentheticals) from a CLI probe; the Telegram path is the authority. Use a
  fresh `--session-id` so probes never pollute the user-facing chat context.

**Working on the spine / Composio:**
- **When inbound email "stops working", check the webhook subscription FIRST** — it's
  SDK-only config (no dashboard page; `GET /api/v3/webhook_subscriptions`). It once pointed
  at a dead dev tunnel for days with zero errors surfaced anywhere.
- The Composio **master API key never goes in a sandbox** — the auth header the SDK returns
  for session MCP is the master key (act-as-anyone). Sandbox access is doorman-relayed
  through Render with per-person session pinning.
- Composio **Connect Links expire** (~hours) — treat as perishable, re-mint on demand.
- Session tool restrictions enforce with HTTP 400 code **4310** (docs wrongly say 403).
- Known race: Composio retries a webhook ~5s in while classify+extract still run → duplicate
  visit (L1 dedup holds). Owned by the async-ingestion work
  (`thoughts/shared/research/2026-06-29-async-webhook-ingestion.md`).
- A badge's tier comes from an ACTIVE roster row matching its ref — a manager badge without
  an active manager roster row silently acts as a plain technician.
- **Google Routes `optimizeWaypointOrder` over ONE intermediate returns the undocumented
  sentinel `optimizedIntermediateWaypointIndex: [-1]`** (docs imply `[0]`; observed live
  2026-07-20). Our permutation guard rightly rejects it, so every 3-stop day silently
  degraded to unmeasured until `optimizeStopOrder` learned to skip the flag when there is
  nothing to reorder (fix + pinning test in `src/routes/googleRoutes.ts`). Moral: the
  fake-Google tests can't catch what only the live API does — run the key-gated live tests
  whenever `GOOGLE_MAPS_API_KEY` is available.

- **Fleet rollouts must enumerate live sandboxes from the box, never from a remembered or
  written-down map** (observed 2026-07-22: the set_promise wire+restart pass covered s2/s3/s5
  from the recorded map and missed s7 — a live, bound manager sandbox added since — leaving it
  on the stale cached tool list until asked). Ground truth: `nemoclaw list` for the container
  set, then `nemoclaw <s> channels status` per sandbox for bindings. Do NOT trust
  `~/.nemoclaw/sandboxes.json` top-level fields for this — botToken/allowedIds read as
  null/absent there even for live, bound sandboxes; `channels status` is the only honest
  binding probe (it reads the rendered runtime config).

**Designing agent behavior (the meta-lesson):** GLM-5.2 does not reliably obey standing
instructions — proven repeatedly (skipped `endTime` despite rules → PR #53 made it required;
skipped the board link despite "offer it" → PR #59 fused it into results; resolved "next
week" ambiguity despite a mandate to ask). **When a behavior matters, move it into the
mechanism** (required params, result-embedded directives, server-side resolution like
`resolve_date`) — prompt rules are steering, not enforcement. Same family: an
append-once AGENTS.md block drifts stale as the product moves — refreshable blocks
(delete-then-append per `wire` run) fixed that class; and long/bulk tasks need the batching
mechanism in [long-running-task-batching.md](long-running-task-batching.md).

## 6. Where the deep detail lives

- **Runbooks:** [doorman-runbook.md](doorman-runbook.md) (badge/doorman ops),
  [control-plane.md](control-plane.md) (lifecycle cron), [nemoclaw-tech-agent.md](nemoclaw-tech-agent.md)
  (agent stack + Composio §7), `Box_Setup_Stuff/` (host-side; self-contained for the box
  Claude — keep it that way).
- **Decision history with citations:** `thoughts/shared/research/` and
  `thoughts/shared/plans/` — dated artifacts for every feature; a plan's final-review section
  lists its known deferred nits.
- **This file** replaces nothing above — it's the map plus the facts that had no home.
