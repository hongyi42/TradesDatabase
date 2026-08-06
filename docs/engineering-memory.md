# Engineering memory — the knowledge that isn't in the code

**What this is:** the institutional memory of this project, written down for anyone who works on
the repo. Until 2026-07-20 most of this lived only in the operator's private Claude-session
memory; a new engineer would hit these walls blind. Facts are stamped with dates — treat every
"current state" claim as a snapshot, and update this file when reality changes.

**Reading order for a new engineer:** start with [onboarding.md](onboarding.md) (the map — what
the project is, how the pieces fit, day-1 setup), then
[Three-Layer-Context-Spine-Overview.md](Three-Layer-Context-Spine-Overview.md) (what we're
building) → `CLAUDE.md` at the repo root (hard rules) → this file (everything in between) →
the runbooks ([doorman-runbook.md](doorman-runbook.md), [control-plane.md](control-plane.md),
[nemoclaw-tech-agent.md](nemoclaw-tech-agent.md), `Box_Setup_Stuff/`).

---

## 1. How we work (process rules)

- **Every code change goes through a PR before `main`** (standing rule, 2026-07-12). Direct
  push only on an explicit per-change waiver. "You may commit" authorizes a commit, **not** a
  push. **Doc-only carve-out (2026-07-13; push extension 2026-07-26):** markdown-only diffs
  (`docs/`, `thoughts/`, READMEs) skip the PR — commit on `main` and push directly (the
  owner-pushes step is retired for doc-only diffs).
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
- **A schedule READ renders the booked order; it never re-derives one** (2026-07-31, user
  decision). `get_schedule` used to ask Google Routes for the "best driving order" and return
  the technician's day re-sequenced — contradicting the times the customers were promised and
  the order the board shows, from a tool that changes nothing and cannot move anything.
  Removed. Both schedule reads now return stops in booked (time) order, and **each stop carries
  its own destination-only `mapsUrl`** instead of one multi-waypoint day link (no 10-stop cap,
  no truncation, and it matches how a day is actually driven — navigate to the next stop, not
  the whole day at once). **Links belong to a PERSONAL route view only** (user decision
  2026-08-03, from live evidence): `get_team_schedule` briefly carried them on the caller's own
  stops and they were removed before merge — that read is a TEAM view by construction, and a
  manager asking "what's on the schedule this week" is dispatching, not driving, so directions
  to their own couple of stops answered a question nobody asked. Corollary worth keeping: the
  right question for a result field is not only *is it correct and correctly scoped* (it was
  both) but *does it belong in the answer to what was actually asked*. A manager's own driving
  day is the board's job. The dividing line to keep: **deciding order means MOVING
  visits** (promises, confirmation, a DB write) — that is `run_freeze`/`run_resolve`'s job, and
  a read must never do it quietly. Upstream fact this rests on: *"Waypoints are displayed on
  the map in the same order they are listed in the URL"*
  (https://developers.google.com/maps/documentation/urls/get-started).
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
- **EXPLORATORY direction — software-for-physical-data exchange** (2026-07-26, not committed):
  possible free/discounted tier where shops trade consented job-site video (quota'd in
  complete-job-gated minutes, narration ×2) for seats — footage as physical-AI training data.
  Full design incl. consent architecture, valuation math, and the **videos-never-enter-L1**
  constraint: [Physical-Data-Exchange-Direction.md](Physical-Data-Exchange-Direction.md).
  Gated on privacy-lawyer review; nothing is built. **A same-day deep supply/demand study
  (§9 of that doc) materially challenged the data-sale half** — raw video without action
  labels is the weakest training modality, no robotics lab publicly licenses third-party
  corpora, 100k+ hours are free under Apache 2.0, and auto-repair robotics is dead
  (RoboTire Chapter 7). What survives: the consent architecture, spine-linked outcome ground
  truth, and provenance+indemnity as the differentiator. Read §9 before repeating any
  valuation number from §3 — a vendor-layer audit (§9.9) found **every per-hour market price
  in this space traces to unsourced SEO content**, and that the free 100k-hour corpus setting
  the price floor has documented consent problems (unpaid, allegedly unconsented Indian
  factory workers). Clean provenance is the scarce good, not the compliance overhead.
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
  **Medic v2 blind spot, proven 2026-07-28 (~01:08–01:20Z stall):** DeepInfra completions hung
  (`LLM idle timeout (120s)` per turn; owner saw Telegram's generic "Something went wrong")
  while the API stayed reachable (keyless curl → instant 422) and the status page stayed
  green — and the medic ticked TWICE mid-stall logging "route OK on primary": its probe
  (`inference set` live-verify) validates endpoint+key with a small call and passes while
  real completions hang. Stall self-cleared in ~12 min. Diagnosis recipe: sandbox
  `gateway-persistent.log` grep → **read back the dead turn's DB writes before assuming it
  did nothing** (the owner's set_availability × 2 had LANDED; only the reply died) → keyless
  curl from box+laptop (reachability vs lane) → `journalctl -u
  nemoclaw-inference-medic.service` → explicit-session probe turn (`--session-id probe-…`,
  never `--agent main`). Candidate medic v3 (recorded, not built): probe with a real 1-token
  completion under a ~30s timeout so completion stalls trip the nvidia-prod failover.

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
      │  badges arrive on a SEPARATE path — the host polls GET /control/badges
      ▼                                        on its own 5-min timer, NOT the cron
 Render (tradesdatabase.onrender.com)
   ├─ spine MCP server (src/mcp/server.ts) ──► Supabase "test" = PILOT LIVE DB
   ├─ /composio relay ──► per-person Composio session (Gmail, Sheets, …)
   ├─ board web + background worker (global bot @DashboardMan_bot)
   ├─ /admin operator cost dashboard (the ONE cross-tenant read surface)
   └─ cron heartbeat, */15 — six sweeps: pairing · grace expiry · Composio session
      provisioning · execution-log ingestion · cost backfill · cost rollup
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
- **A new tool surface silently bypasses whatever doctrine rule did not name it — twice now.**
  Tool search broke §0f by making `resolve_date` something the model had to *find* (fixed by §0j,
  then reverted with it). `query_spine` broke the same rule a different way: on its first live turn
  (2026-08-06) the agent wrote `local_day >= '2026-07-07'` straight into SQL with no `resolve_date`
  call — correct by luck. Harmless for a count; the identical shape on "what's booked next week"
  is the 2026-07-25 week-boundary incident, which missed a real visit.
  **The durable fix is to stop enumerating tools in doctrine.** §0f rule 2 said "never hand a
  YYYY-MM-DD you calculated to book_visit or move_visit" — a list, so anything not on the list was
  implicitly fine. It now reads "to ANY tool … if a date reaches a tool, it came out of
  resolve_date", with the SQL case named explicitly. The `query_spine` description carries the
  same rule fused in, and `src/mcp/server.test.ts` asserts that text so it cannot be edited away.
  **When adding any tool that takes free-form input, re-read the doctrine blocks and ask which of
  them name tools rather than behaviours.**
- **Bake derived values into the views; the agent computes anything you leave out, and gets it
  wrong (2026-08-06).** `v_schedule` had `local_day` but no weekday. Asked "how many visits did Joy
  do this week?" the agent did everything the previous fix required — `resolve_date {week:0}`
  first, its boundaries pasted into the SQL, 22 visits, verified correct — then reported *"running
  from Monday the 4th"*. **2026-08-04 is a Tuesday.** §0f requires stating the weekday whenever a
  date is named, so with none to read it derived one. The count being right is what makes it
  dangerous: nothing in the answer looks suspicious.
  Fixed by adding `local_weekday` (`to_char(…, 'FMDay')`; FM suppresses Postgres's blank-padding)
  beside `local_day`, plus a description line to select and relay it verbatim. Tests guard the
  column and the description text.
  **`CREATE OR REPLACE VIEW` may only APPEND columns** (42P16 "cannot change name of view column");
  inserting one mid-list needs DROP + CREATE — atomic inside a migration, re-grant afterwards.
  **The pattern, four for four in three days:** tool search hid `resolve_date`; `query_spine` let
  dates be written straight into SQL; a view handed over a bare date; and then `resolve_date` itself
  turned out to hand over bare dates for week RANGES. Each fix was correct and each exposed the next
  gap. Generalisation worth carrying: **any value the model must derive in order to answer well is a
  value it will eventually derive wrong — put it in the data, not in a rule telling it not to.**
- **`local_weekday` did not close it — `resolve_date` week ranges were the real hole (2026-08-06).**
  The re-test after shipping `local_weekday` looked like a pass: "Joy has 22 visits this week
  (Mon Aug 3 – Sun Aug 9)" is entirely correct. It was still derived. The agent's SQL was
  `select count(*) … where local_day between …` — it selected no weekday column at all, so
  `local_weekday` never entered the answer. **A view column can only help when the agent names a
  date it SELECTED; the dates in that sentence were the WINDOW's boundaries, and those come from
  `resolve_date`.** Naming the window is by far the commoner shape, so the fix was aimed one layer
  off. `ResolveDateResult.resolved` had carried a `weekday` since day one; `resolved_week` returned
  `{weekStart, weekEnd}` and nothing else.
  Fix: `weekStartWeekday`/`weekEndWeekday` plus a ready-to-say `phrase`
  ("Monday 2026-08-03 through Sunday 2026-08-09") on every resolution, single dates included, and
  the same on the weekend-ambiguous `alternate` — the branch that asks the agent to read BOTH ranges
  to a person. Built through one helper each so a future return site cannot ship a date without its
  weekday. The labels are constants by construction (weekStart IS a Monday), which is the point:
  handing over a value the model could in principle derive is precisely how you stop it deriving.
  **Verification lesson:** a live turn that produces the right answer does not prove the fix fired.
  Check the mechanism — here, `query_audit` showed the SQL never selected the column. Right answer,
  wrong reason, and the next week it would have been the 2026-08-06 "Monday the 4th" bug again.
- **The weekday fabrication is ENDEMIC, not episodic — 23 mismatches in 419 historical texts
  (2026-08-06).** Built the outbound weekday guard (observe-only `message_sending` plugin,
  chrono-node, see nemoclaw-tech-agent.md §4c) and replayed it over every assistant text in the
  fleet's transcripts before deploying. Expected to confirm the 3 failures found by hand; found
  23, **all verified true positives, 0 false positives** — ~4% of assistant texts state a
  (weekday, date) pair that is internally inconsistent. Reach: a slot-proposal list with FIVE
  consecutive wrong labels (one wrong anchor, derived down the list), a freeze proposal
  ("Sat Aug 9" — a Sunday), a customer-facing date change ("Friday August 17" — a Monday), and
  the ORIGINAL July 17/18 "this Friday" booking incident, rediscovered in the transcripts by the
  detector. Two conclusions worth carrying: (a) "resolve_date worked fine before query_spine" was
  survivorship bias — the derivation failures were always there, in lists and confirmations nobody
  re-checked; a detector, not more instructions, is what made them visible. (b) A GitHub survey
  first (Guardrails hub's 40 validators, NeMo-Guardrails, code search) found NO existing
  temporal-consistency validator — the primitive that makes ours cheap is chrono-node's
  stated-vs-inferred (`isCertain`) distinction, which is what holds false positives at zero:
  flag only when the text states BOTH halves of the pair. The concurrent-feature
  workflow puts whole extra checkouts at `.claude/worktrees/<name>`, each with its own
  `tsconfig.json`. typescript-eslint then finds multiple candidate `tsconfigRootDir`s and refuses to
  parse ANY file: 289 errors, none real, on files the worktree has nothing to do with. Fixed by
  ignoring `.claude/` and pinning `tsconfigRootDir: import.meta.dirname` in `eslint.config.js`.
  Worth knowing because the failure looks catastrophic and is purely environmental — and because it
  was masking a genuine `no-unused-vars` error in the suite.
- **The inference failover is broken — it turns a blip into an outage and reports success
  (2026-08-06).** A ~4-minute DeepInfra unhealthy window failed the fleet over to `nvidia-prod /
  z-ai/glm-5.2`; the medic logged "FAILOVER active; will fail back automatically", but NVIDIA
  returns `400 (no body)` on a real completion, so turns died in 0.8s with
  `terminalError: non_deliverable_terminal_turn`. **Failover therefore provides NO protection** —
  it converts a recoverable provider blip into a hard outage while reporting success. Same blind
  spot as the 2026-07-28 stall: `openshell inference set` doubles as probe and switch, and it
  validates the **endpoint registration**, not a completion. The differing model ids
  (`zai-org/GLM-5.2` deepinfra vs `z-ai/glm-5.2` nvidia) are deliberate and NOT the bug — NVIDIA
  accepts the registration, then 400s the request. Suspect the rotated NVIDIA key (the old one
  lingers in `/root/s4-nvidia.env`) or model entitlement. **medic v3 — a 1-token real-completion
  probe, run against the FALLBACK before declaring failover successful — is now urgent rather than
  a nice-to-have.**
  Debugging path: `journalctl -u nemoclaw-inference-medic` gives the failover timestamp; the real
  error is only in the sandbox's `/sandbox/.openclaw/logs/gateway-persistent.log`
  (`embedded run agent end: isError=true … error=400`). The trajectory says only
  `non_deliverable_terminal_turn`, which is useless alone. Route changes apply WITHOUT a container
  restart (the 19:52:53 turn used the route set at 19:52:14) — unlike credentials, which need one.
- **`nemoclaw list` shows the ONBOARDING RECORD, not the live inference route (2026-08-06).** Read
  off that list, s2/s5/s6/s7 all say `provider: nvidia-prod` — which reads exactly like "the fleet
  has been stuck on the fallback for six days", and was reported as such before being checked. It
  is wrong. `nemoclaw list` prints each sandbox's onboarded model/provider from `sandboxes.json`;
  the medic switches the **global gateway route** (`openshell inference set -g nemoclaw`) and never
  rewrites those per-sandbox fields. A failover stales them permanently and a failback never clears
  them — the same cosmetic-drift class as s3's nemotron ref. s8 is the most misleading: it keeps its
  true onboarded value (`deepinfra-prod`) and prints a "live OpenShell gateway differs" note that is
  itself stale.
  **Authoritative:** `openshell inference get` for the route, plus
  `journalctl -u nemoclaw-inference-medic.service` for whether the 5-minute assertion is passing now.
  **For proof the model actually SERVED** — which `inference set` can never give, see the blind-spot
  entries above — query the pilot's `cost_events` for `provider='deepinfra'` rows with skus
  `glm-5.2-{input,output,cached-input}`. Those are billed completions, and they need no API key.
- **The cost tracker is blind to the failover provider (2026-08-06).** `cost_rates` holds
  `deepinfra` and `anthropic` rows only — there is **no `nvidia` row**. So a failover does not
  appear as a provider change in the cost data; it silently stops the meter. Two consequences:
  absence of nvidia rows is NOT evidence the fleet wasn't on nvidia, and a stretch of "zero spend"
  may mean *failed over*, not *idle* (07-31 and 08-04 each show 21 spine tool calls and zero model
  cost events). Add an nvidia rate row — even at $0 — if failover spend or attribution ever has to
  be answerable after the fact.
- **`revoke ... from public` does NOT revoke anon/authenticated on a new function.** Supabase's
  DEFAULT PRIVILEGES grant EXECUTE on a newly created function in `public` *directly* to `anon` and
  `authenticated`; those are separate grants, so revoking PUBLIC leaves them. Hit live on the pilot
  2026-08-06 with `query_spine`, whose ACL read
  `spine_reader=X | anon=X | authenticated=X | service_role=X` after a migration that "revoked from
  public". It mattered because query_spine takes the TENANT AS A PARAMETER — anyone with the
  publishable anon key could have called it for ANY tenant. Fixed by
  `revoke execute … from public, anon, authenticated`, and `src/db/querySpine.test.ts` now asserts
  the ACL (verified to fail when the grant is restored). **Always name anon and authenticated
  explicitly; compare `tenant_cost_detail`, which is correctly `postgres|service_role` only.**
- **anon-readable tables on the pilot are a DELIBERATE posture (owner, 2026-08-06) — do not
  "fix" them.** Measured that day: with RLS off and `anon` granted SELECT, `customers`, `jobs`,
  `assignments`, `technicians`, `tenants`, `visits` and `raw_captures` are readable with the
  publishable key; `cost_events`, `call_ingest` and `query_audit` are not (RLS on). The owner
  confirms RLS-off is intentional here, and the mitigation is that the anon key appears nowhere in
  this project — so this is exposure-by-key-disclosure, not open data. **Treat the anon key as a
  secret on this project**, because it is load-bearing in a way it is not on a typical Supabase
  app. Raise it again only if the key is ever published (a web front end, a client bundle, a doc).
  What the **2026-10-30** date actually means: Supabase removes the `api.auto_expose_new_tables`
  option, after which NEW entities stop being auto-granted to anon. **Existing grants are
  unaffected** — it is a change in the default for future tables, not a remediation deadline.
  Not affected either way: the `v_*` query_spine views. They are granted to anon but fail closed
  (SQLSTATE 42704, `unrecognized configuration parameter "spine.tenant_id"`) because anon cannot
  set the GUC — verified by setting `role anon` on the pilot.
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
| s8 | manager-joy (Joy, manager, active, Default Tenant, TG 8816690083) | onboarded 2026-07-24; a crashed restart left a stale shields-transition lock (see ops trap below) — owner cleared it 2026-07-25 and the gateway now restarts clean (wired + restarted with the fleet, tool list fresh). The `nemoclaw list` "differs from onboarded" note (nvidia-prod live vs deepinfra-prod onboarded) reflects the medic's balance-out NVIDIA failover, not a broken sandbox |
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
  s2/s3/s5/s7 restarted (s8 followed once the owner cleared its stale lock). **Same-day wire
  pass** (the step gateway restarts do NOT cover — AGENTS.md blocks only refresh on
  `bootstrap-box.sh wire`): updated script shipped to the box, s2/s3/s5/s7/s8 wired, all 5
  gateways restarted again; verify grep shows unschedule_visit×3 + cancel_job×2 in every
  sandbox's AGENTS.md. Residual: the append-ONCE accuracy-rules block on s2+s3 still lists
  "(…, book_visit, move_visit, cancel_visit)" as staged tools — dead name AND contradicts the
  one-shot doctrine; owner owes the one-line in-container sed + `/usr/local/sbin` install;
  structural fix = make that block refreshable (delete-then-append) like the doctrine block.
  **GLM swap (PR #81): LIVE since ~2026-07-26 (owner confirmed — `INFERENCE_API_KEY` set on
  Render and deployed).** The spine's four forced-tool calls (classify/extract/brief/answer)
  now run GLM-5.2 via DeepInfra; `MODEL_PROVIDER=anthropic` remains the env-var revert.
  Inbound classify E2E runs externally (owner's collaborator), not through this pilot.
  Live probes on s2 passed:
  `find_slots` fail-closed → set length 90 → SQL read-back → candidates from the job's own
  length; `unschedule_visit` → "work isn't cancelled … back in the loose bucket" + assignment
  `cancelled`/job `open`; `cancel_job` → two-step demanded, visit cascade, terminal `cancelled`,
  ledger triple (`booked`/`cancelled`+`jobCancellation`/`job_cancelled`); minted-shell
  `duration_minutes` recorded (60). Telegram-path doctrine + board device checks remain the
  owner's pass (CLI probes can't judge AGENTS.md-dependent behavior). **Device pass CLOSED
  2026-07-25 (owner):** board 4b-1 checks (A) ✓, Unschedule labels (B) ✓, chat doctrine (C)
  ✓ — C9 ask + C10 cancel_job two-step + C11 one-shot unschedule + C12 board links all
  confirmed; week-range phone check ✓ (week-mode plan flipped complete). **Ben's technician
  phone pass (D) DEFERRED again; GLM-classify live check (E) DROPPED — owner's friend runs it
  on his own laptop, not through this pilot.** **Device-pass finding
  (2026-07-25, owner): verb-follows-noun gap** — vague "cancel Tom …" correctly triggers the
  which-kind ask, but "cancel <person>'s visit <day>" (noun = visit) silently resolves to
  unschedule with no cancel_job offer. Mitigations that held: promise-gated confirm + the
  preview's "work stays open → loose bucket" disclosure before acting; edge = promise-none
  one-shots disclose only after the fact (reversible). Candidate fix, recorded not built: a
  result-embedded self-heal line on unschedule preview/one-shot replies — "if the WORK itself
  is dead, say so and I'll cancel the job instead" (the book_visit promiseLevel-line pattern;
  server result strings need only a deploy, no fleet restart). C10 rerun (owner, later same
  day): the agent DID ask which-kind for a visit-noun phrase — the gap is GLM-variance, not
  deterministic, which strengthens the self-heal-line case. Second copy nit from C10: the
  unschedule option says the job "goes back to the loose bucket" even when the visit is
  UNASSIGNED (already tray-visible — it never left); candidate conditional phrasing when
  technician_id is null, same deploy-only result-string class.
  **"next <weekday>" both-and-ask rule VIOLATED live 2026-07-25 (trajectory-diagnosed,
  same day as the week fix):** "is there any job next thursday" (asked on a Saturday) →
  agent called `resolve_date {weekday: thursday, weeksAhead: 1}` ONCE (→ Aug 6), silently
  picking one reading despite the description's explicit resolve-both-and-ask order; the
  manager meant Jul 30 (weeksAhead 0). The rule exists only as prompt-layer steering (tool
  description + §0f item 3) — the documented GLM class. Candidate mechanism (week-mode's
  sibling, recorded not built): a `saidNext: true` flag on weekday mode — the server returns
  BOTH candidate dates + a result-embedded ask note, shrinking the agent's job from
  "resolve twice and compose the question" to "relay the result". Also verified same session:
  NO date is injected into agent context — today's date appears ONLY in resolve_date results
  (by §0f design), confirmed by a full-session grep (1 hit, the tool result).
  **Temporal grounding riders SHIPPED 2026-07-25 (user decision after the eval re-run —
  A 66.3% / B 80.6% / C 99.0%, re-run recorded in the date-reliability research doc):** every
  successful object tool result carries `now` (the condition-B line: date + weekday + tz,
  firm-local, 10-min-memoized tenant tz) via the ONE decoration seam in `src/mcp/server.ts`
  (same seam as boardLink). Arrays keep their shape. Self-refreshing across midnight — the
  reason injection-at-session-start was rejected; OpenClaw has no per-prompt injection hook
  (config scan + vendor docs check, github.com/openclaw/openclaw issue #53404 still open).
  resolve_date STAYS the arithmetic authority (the eval's weekday-walking tier: 41% with
  injection alone, 98%+ with the tool). Rollout: deploy-only — result fields are per-call,
  NO fleet gateway restart needed (tools/list unchanged). Rider is BEST-EFFORT (review
  finding): it decorates after dispatch has committed, so a grounding failure omits `now`
  rather than erroring a committed result (which would invite a retry double-book).
  **Deliberate decision (2026-07-25): NO AGENTS.md/bootstrap line for the rider** — condition
  B works by mere presence in context, unlike boardLink which needed a fused instruction to
  make the model ACT. Watch item for the next device pass: does the agent parrot "Right now
  it is…" into replies? If yes, a one-line "never quote the `now` field" rides the NEXT wire
  change (not a wire pass of its own).
  **resolve_date week mode SHIPPED + REPLAY-VERIFIED 2026-07-25 (PR #82):** the deferred
  Sat/Sun boundary item, promoted and closed same-day. Replay of the verbatim failing
  message on a fresh session: `resolve_date {week: 1}` → both Monday-anchored windows
  searched (Jul 27–Aug 2 primary + Aug 3–9 alternate) → the previously-invisible Tom Nguyen
  Monday visit FOUND outright. Evidence in the plan
  (`thoughts/shared/plans/2026-07-25-plan-resolve-date-week-mode.md`).
  Doctrine from the Plan-3 reshape stands: **no monolithic auto-scheduler; agency stays in the
  agent, tools measure** (research: `thoughts/shared/research/2026-07-20-flexible-scheduling-agent-toolset.md`).
  **Unplaced visits (plan 4b-2) LIVE 2026-07-26 (PR #84 merged+deployed; pilot migration
  applied 2026-07-25 via MCP — recorded on the pilot as version `20260726043149 ·
  unplaced_visits`, NOT the repo file's `20260724130000`; the MCP stamps its own apply-time
  version, same as 4b-1's `job_duration_ladder` — so `migration list --linked` under-reports
  and `db push --linked` would try to re-apply the local file and fail on existing columns;
  trust schema read-backs, not the version ledger):** rollout completed same day — served
  board.js byte-identical to main; s2/s3/s5/s7/s8 gateways restarted, wire pass shipped the
  updated doctrine block (timeTbd ×2 verified in every AGENTS.md), gateways restarted again
  (s6 stays parked); live probes on s2 all passed: staged timeTbd+day-promise booking on a
  real customer (preview said "Time: not set (TBD)"), row read-back exact unplaced shape,
  recall view listed "time not set (TBD) | promised the day", placing via chat one-shot with
  "no promise broken" (same promised day) and range→times swap verified, cancel_job two-step
  restored the pilot (0 live probe visits). Wire-pass PATH note: non-interactive ssh lacks
  `~/.local/bin`, so `bootstrap-box.sh wire` dies at its bare `nemoclaw` call — prefix
  `PATH=$PATH:/home/ubuntu/.local/bin`. Residual: the 7 manual board checks (strip rendering,
  range-spans-3-days reads as ONE visit per day, unplaced-only day renders, sheet + Place,
  tray Assign keeps it unplaced, tech phone unchanged, booking-form TBD toggle) are the
  owner's phone pass. Check ordering matters: the STRIP only shows ASSIGNED time-TBD work,
  so book-unassigned lands in the TRAY (correctly, no strip) — Assign FIRST, then run the
  strip checks. The tech-phone check (no strip on Ben's view even for HIS OWN time-TBD
  visit) is DEFERRED into Ben's standing device pass (owner decision 2026-07-26) — 4b-2's
  plan flips to complete on the 6 manager-phone checks; Ben's box closes with his pass.
  **MANUAL PASS DONE 2026-07-26 (owner, combined 11-step walkthrough on the deployed PR #85
  job sheet): all 6 manager-phone 4b-2 checks + all 5 job-sheet checks confirmed — 4b-2
  plan status: complete.** The only open 4b-2 box is Ben's tier check inside his standing
  device pass. An assignments row is now PLACED (`starts_at`+`ends_at`, range null)
  **or** UNPLACED (`earliest_date`+`latest_date` DATE range, times null) — never half of each
  (`assignment_placed_or_windowed` CHECK). Facts other work builds on: (a) the `no_confirmed_overlap` double-booking guard is
  **narrowed to placed rows** (`starts_at is not null` — an unplaced tstzrange(null,null)
  would have blocked the whole calendar; unplaced = demand, not schedule); (b) the PR #53
  "times required" rule has its **one recorded exception**: `book_visit timeTbd:true` +
  `earliestDate`/`latestDate`, explicit-manager-words only, promise `none`/`day` only;
  (c) time-filtered readers return `PlacedAssignment` by construction — an assigned unplaced
  visit is served by `listUnplacedAssignedForRange` (board strip per covered day, windowed
  `get_team_schedule` on its clamped earliest day) and a person-less one by the widened
  `listUnassignedAssignments` (tray + `unassignedOnly` recall); (d) placing = normal
  `move_visit` (endTime falls back old span → job `duration_minutes` → explicit required);
  attach/detach-keeping-unplaced = `attachUnplacedVisit` (board `/move` `attachUnplaced:true`);
  (e) fit engine: unplaced work adds day LOAD (`commitmentsByDate`), never day SHAPE
  (`DENSE_DAY_STOPS` counts placed stops only). `npm run gen:types` (--linked) is unblocked
  now the pilot migration is applied. Doctrine-block ordering recipe (held for this rollout,
  keep for the next): AGENTS.md contract changes wire only AFTER the server deploy, or
  agents pass flags the server doesn't know.
  **Board job sheet + priority retired from board copy (PR #85, 2026-07-26, two user
  decisions):** tray job rows now open a JOB SHEET (Purpose ✎ / Length ✎ / Customer /
  "Book visit" primary) — the old split (invisible tap-to-book + lone visible Edit button)
  taught users the pencil was THE action. Deliberate details: edits return to the sheet, not
  the tray; NO Cancel button on a job sheet (reads as "cancel the job" — ✕/backdrop close).
  **Priority is a board-UI-retired field, not a dead field:** 24/24 pilot jobs sat at
  routine (nobody speaks enum mid-booking); it stays in the schema, in `find_slots` scoring
  (EARLINESS_PER_DAY 30/15/3/1), in chat (`update_job` — the agent translates "burst pipe" →
  emergency), and `/board/api/job` still accepts it. Board copy must not resurface it without
  a new decision. Length-vs-times doctrine (recorded while deciding this): a visit's
  explicit start–end ALWAYS wins for that visit; job `duration_minutes` is the planning
  default (sizes find_slots, proposes a move's end, measured-once onto a minted shell) —
  a mismatch is legitimate and never reconciled.
  **4b-3 THE FREEZE LIVE — ROLLED OUT + BOTH E2Es PASSED 2026-07-27 (PR #86 → main
  b6e23d3).** Rollout in the correct order: gates re-run on merged main (715 pass); served
  board.js byte-identical; pilot geocoding migration via MCP + 3-column read-back (the MCP
  stamps its own apply-time version — trust read-backs, as with 4b-1/4b-2); the user ran
  the one-time lock reset AFTER the deploy (read-back 16 locked → 0); wire pass
  s2/s3/s5/s7/s8 (verify grep per sandbox: freeze-ritual ×1, run_freeze ×2,
  set_visit_locks ×2) and all five gateway restarts health-passed. **Phase-4 live E2E
  PASS** (s2 probe): proposal = 3 placements (incl. a person-less exact-time row keeping
  its stored times, solver picked WHO) + 3 skips WITH reasons (2 pattern-less people by
  name; a past-dated person-less row) + capacity table + pin line "0 pinned"; confirm →
  rows at exact proposed times, ALL `locked=false`; ledger = ONE `freezeRun` stamp across
  2× booked (reason "freeze <date>") + 1× moved + `freeze_committed` appended last; lazy
  geocode persisted DURING the solve; full restore through the normal verbs (queues back
  to 2+2, 0 pinned). **The first real `optimizeTours` call returned HTTP 200** — SA-key
  auth + the self-serve SKU are empirically proven (local probe recipe: minimal
  1-vehicle/0-shipment body; prints status only, never the token). **Phase-5 ritual E2E
  PASS**: agent-created one-shot cron (deleteAfterRun; payload = the §0h contract) fired
  at 09:30Z → job gone from the container cron store, a NEW `pending_freeze` staged at
  09:30:42Z, and ZERO schedule writes with queues untouched — the fire proposed and
  STOPPED; cleanup exercised kind-wide supersede + `resolve_review dismissed` live.
  **Traps recorded from the rollout:** (a) Geocoding `REQUEST_DENIED` root cause was the
  KEY's own API-restriction list lacking Geocoding API — enabling the API on the project
  is NOT enough when the key carries an allowlist (fix: Credentials → key → API
  restrictions → add Geocoding API; no env change, key value unchanged); the failed run
  also proved the failure path (error relayed honestly, nothing staged). (b) Render env
  values are BARE — the dotenv single quotes around `GOOGLE_ROUTES_SA_KEY_JSON` are
  file syntax, not value; paste the raw one-line JSON. (c) **Agent-behavior finding
  (candidate copy fix — bundle with the next tool-description wire pass, like the
  chat-vs-board vocab item): the agent could not find the freeze dismiss lever unaided**
  — `resolve_review`'s description is written in pairing-verification terms only, so it
  claimed "the only lever is 12h expiry" and, worse, dismissal nudges made it RE-RUN the
  freeze (kind-wide supersede) instead; it used `list_pending_reviews` →
  `resolve_review dismissed` correctly the moment it was pointed there. **Phone-check
  verdict (owner, 2026-07-27): the cron proposal DID land but readability FAILED —
  schedule tables render poorly in Telegram text; owner's direction = a READ-ONLY
  freeze-proposal view on the existing board Mini App (board shows the plan, chat keeps
  the human yes — ritual doctrine untouched); research:
  `thoughts/shared/research/2026-07-27-freeze-proposal-board-view.md`.**
  **PROPOSAL VIEW LIVE 2026-07-28 — PR #88 merged (main 387f1c8), rollout complete:**
  served board.js byte-identical; wire pass ×5 (new §0h `proposalLink` phrase verified
  per sandbox) + five gateway restarts health-passed; s2 live E2E: the freeze reply is a
  compact summary ENDING with the exact deep-link line
  (`t.me/<bot>?startapp=freeze`), and the **unaided-dismiss retest PASSED** — a plain
  "get rid of that proposal" (no tool names) → token dismissed, zero writes; pre-rider
  the same ask made the agent re-RUN the freeze. Watch item: at pilot scale (3
  placements/3 skips) the agent relays the compact FULL list rather than strict
  counts-only — acceptable; re-judge on a large plan. Suite context: PR #87 (cost
  dashboard) merged just before #88 — its `cost_events` migrations timestamp BEFORE the
  geocoding migration, so a local stack needs `npx supabase migration up --include-all`
  (plain `migration up` refuses out-of-order inserts); the first post-apply suite run
  can flake on state left by the pre-migration failures — rerun before diagnosing.
  Plan `thoughts/shared/plans/2026-07-27-freeze-proposal-board-view.md`.**
  Owner decisions: deep link + header pill (no tab); manager-only. Shape worth knowing:
  `assessStagedFreeze` (src/schedule/freezeProposal.ts) is now THE staleness kernel —
  the `run_freeze` confirm branch and the board's `GET /board/api/freeze-proposal` both
  consume it, so open/expired/stale/malformed agree by construction (and a corrupt token
  now dismisses as malformed instead of crashing AFTER consuming — behavior change,
  pinned). The decoration seam's ONE staged exception: run_freeze's stage result carries
  `proposalLink` (`?startapp=freeze`) + fused `boardNote` — never `note` (the stage
  result's own instruction lives there; a same-named attachment would clobber it
  silently when the handle is set). All three chat-copy homes key the fallback on the
  **`proposalLink` field BY NAME** — "board link" prose sent a field-literal agent down
  the full-plan fallback on every decorated stage (final-review catch). Deep-link
  fallback reads `tgWebAppStartParam` from query AND hash (Telegram Web uses the
  fragment). Rollout classes when merged: deploy (note copy) + gateway restarts ×5
  (descriptions incl. the resolve_review rider) + wire pass ×5 (§0h now says
  summary + link). Recorded-not-fixed: two-open-token stage race (pre-existing, tiny
  window); probe returns the full payload per manager paint (`?summary=1` = the future
  lever); a `boardView`-declaration seam is the generalization if a second staged tool
  ever grows a board view.
  **Pin-protection live addendum (2026-07-27): PASS** — the first two E2Es ran post-reset
  with 0 pinned items, so the protection path was verified separately, stage-only: chat
  pin → `locked=true` read-back → `run_freeze` proposal skipped it ("pinned by a manager
  — the freeze never touches pinned visits", pin line = 1, solver re-planned around it)
  → dismissed + unpinned; read-back 0 open tokens / 0 pinned / 0 schedule writes,
  queues intact. REMAINING: the Pinned-chip phone check, then the plan flips complete
  (the readability box closes as done-with-finding).
  **PER-TICK PUSH DIGEST LIVE 2026-07-28 (PR #89), owner-requested:** a freeze commit
  used to machine-gun each technician with one push per placed visit (recurs every
  weekly freeze). `boardNotify.pollOnce` now resolves the whole tick before sending,
  groups per recipient, and collapses any run of MORE than `DIGEST_THRESHOLD` (3)
  messages into one digest (bullets reuse the single-push sentences; cap
  `DIGEST_MAX_LINES` 12 + "…and N more" — Telegram 4096 guard). A burst whose events all
  share one `freezeRun` stamp gets "The schedule freeze updated your schedule:" —
  deliberately COUNTLESS (a slow commit can straddle two poll ticks, so a batch count
  would misstate the freeze). Cursor semantics unchanged and now test-pinned both ways
  (mid-batch resolution failure holds + resends nothing — injected via
  `vi.mock('../db/index.js', { spy: true })`). Recorded trade: a digest is ONE send, so
  one transient send failure loses the whole burst (same no-replay posture as the
  in-memory cursor; board = source of truth). Rollout class: board-worker redeploy ONLY
  (no wire pass, no gateway restarts). Digest verified live by the owner 2026-07-29
  (5-visit burst onto manager-sam arrived as one message). Owner direction same day:
  notifications should arrive in the NEMOCLAW AGENT chat rather than the board bot
  (board interaction is rare); design fork open — see the notification-transport
  decision brief in the session log / upcoming plan doc.
  **PRIORITY CALL (owner, 2026-07-30): re-solve mode FIRST; 4c and the notification
  transport swap both DEFERRED.** 4c's read-only research is done and stands
  (thoughts/shared/research/2026-07-30-plan-4c-customer-sender-foundations.md — headline:
  no customer-facing sender exists; only 2 phones + 1 email across 37 pilot customers; no
  customer-contact edit verb anywhere; sender-identity fork still open). Re-solve mode =
  the horizon-wide re-optimizer where every unpinned visit is movable and promise level
  sets the degree of freedom ('time' immovable, 'day' slides within its day, 'none' free);
  it subsumes the deferred 3c reflow_day sketch. Research cycle started 2026-07-30.
  **RE-SOLVE + UNDO BUILT 2026-07-30 (branch `feature-run-resolve`, plan
  `thoughts/shared/plans/2026-07-30-run-resolve-reoptimizer.md`; every phase
  adversarially reviewed; PR/rollout pending):** `run_resolve` = the freeze's sibling —
  every UNPINNED confirmed placed future visit becomes a movable shipment (hard window =
  promise-graded freedom: 'none' → horizon, 'day' → its promised day; 'time'/'time_only'
  stay fixed context in v1) with a SOFT window pinned at its current slot so displacement
  is priced (`DISRUPTION_COST_PER_HOUR` 1, `TECH_CHANGE_COST` 2 via costsPerVehicle —
  emergent: day hops cost ~24, same-day shuffles are cheap); queues drain in the same
  solve (resolve ⊇ freeze); un-moved rows report as KEPT. **Batch-move commit ordering**
  (the crux): `orderMoves` toposorts vacate-before-arrive edges; a true cycle (strict
  swap) PARKS its lowest-id member person-less at its current times (guard-exempt), the
  rest commit in order, and the park re-attaches LAST **against its REMINTED post-park
  id** (moves cancel+remint — the pre-park id is a cancelled row); un-reattached parks
  surface as `strandedParks`, never routine skips. Token = `pending_resolve` through the
  SAME 12h staleness kernel (version pinned BEFORE the solve); the board proposal
  view/pill/sheet are now kind-agnostic with a Moves section (from→to weekday labels,
  techChange only when the person changes, server-composed). Both commit replies now end
  with the **pin OFFER** (unconditional — partial commits too): one manager yes →
  `set_visit_locks` with the MINTED ids the reply carries (staged ids are cancelled rows
  post-commit — passing them would abort the pin batch). **`undo_run`** = restore, never
  re-optimize: no solver; the run-stamped ledger + cancelled predecessor rows ARE the
  memory. planUndo COLLAPSES same-run `previousAssignmentId` chains (a park+attach swap =
  two events, one visit) to the live final row + true pre-run state; drift/pinned/
  gone-technician rows skip with reasons, never force-revert. Commit order: ALL
  unschedules first (placements landed in freed gaps), inverse moves through the SHARED
  batch executor (ordering + park + promise belt), time-TBD rebooks last; tbd rows
  vacated but never re-booked surface as `strandedUnplaced` ("NOT unchanged — job in the
  loose bucket"). `pending_undo` token: 15-MIN TTL (send_email idiom), version read
  BEFORE the plan reads, confirm re-checks version AND latest-run identity, latest run
  only (undo summaries aren't candidates — a spent run honestly reports
  nothing_to_restore). Manager surface 37 → **39 tools** (`run_resolve`, `undo_run`);
  suite 855 → 891. Rollout classes when merged: deploy + wire pass ×5 (§0h ritual now
  covers all three verbs) + gateway restarts ×5; live E2Es per the plan's Phase 6
  (stage-only s2, scoped commit on manager-sam, undo ride-along, digest headers, board
  Re-plan phone check).
  **REALISTIC WA SEED 2026-07-28 (owner-authorized pilot write; scratchpad scripts
  seed-wa-visits.mjs + seed-wa-resume.mjs):** Default Tenant now models a real firm —
  all 37 customers carry real, geocode-verified street-level Puget Sound addresses
  (9 re-addressed from the Fresno placeholders — nulling `lat/lng/geocoded_at` in the
  SAME update per the customers.ts guard, then refilled with verified coords — plus 28
  new; 0 rows without coords); 121 placed visits Jul 29–Aug 9, 4-5 per tech-workday
  inside availability patterns, geographically clustered per day (hman 36 = Seattle,
  manager-joy 40 = Eastside, yutao 45 = South King/Tacoma); loose queue stocked (+6
  duration'd jobs incl. 2 urgent, 3 person-less exact-time visits, 4 timeTbd fenced —
  2 attached); exactly 2 OPEN pinned visits (both Aug-4). Traps hit: Joy's roster ref
  is **`manager-joy`**, not 'joy' (first run crashed mid-phase-D; the resume script
  guards with a refs-already-in-window check); terminal (cancelled) assignment rows
  retain stale `locked=true` — always filter status when counting pins. The seeding
  run doubled as the digest's first live burst (Joy + Yutao are Telegram-bound; hman is
  unbound and silent). Owner-court: their own freeze E2E on this data + digest verdict.
  Five phases: (1) pinning became a HUMAN privilege — `bookVisit`/
  `moveVisit` no longer auto-stamp `locked:true` (moves/attaches carry the flag);
  `setVisitLocks` core = ONE guarded bulk UPDATE (atomic, `status in (confirmed,proposed)`
  predicated), `set_visit_locks` chat verb + `/board/api/lock` + Pinned chip on day grid,
  strip, tray, and sheet toggle; manager surface 35 → **37 tools**. (2)
  `customers.lat/lng/geocoded_at` + lazy Geocoding fill (`ensureCustomerCoords`;
  no_address vs unlocatable reasons; migration applied LOCAL + PILOT, read-back
  verified). Audit fact: NO address-column updater exists in src/ today; whoever builds one must
  null the coords in the same update (guard comments at `updateCustomerCoords` + the
  migration header). (3) `roiClient` (Route Optimization API needs a SERVICE ACCOUNT —
  API keys/end-user creds refused; projectId read from the key JSON;
  `GOOGLE_ROUTES_SA_KEY_JSON` one-line in env) + `freezeSolve` (vehicle per tech-workday,
  pattern gaps as breaks, placed visits = context shipments with LARGE penaltyCost never
  mandatory, fences → ONE contiguous arrival window — **the API rejects adjacent
  TimeWindows**, cited in-file; response parsing keys on LABELS — proto3 omits zero-valued
  indexes). (4) `run_freeze`: always two-step; ONE tenant-wide `pending_freeze` token (12h
  expiry, kind-wide supersede, `scheduleVersion` pinned BEFORE the solve, consume-first,
  stage-race closed by rewriting detail); commit walks the normal verbs sequentially with a
  promiseBroken belt and relays per-row warnings; `freeze_committed` summary pushes to
  MANAGERS. (5) §0h freeze-ritual AGENTS.md block (refreshed per wire run): a cron-fired
  freeze presents the proposal and STOPS — the manager's yes in the conversation is the only
  commit path. **ROLLOUT ORDERING TRAP: the one-time pilot lock reset (`update assignments
  set locked=false where status in ('confirmed','proposed')`) runs AFTER the deploy and
  BEFORE the first freeze/board use** — without it every pre-4b-3 row reads "pinned" and the
  first freeze skips the whole backlog; before the deploy, the old code re-stamps.
  **Recorded limitation:** the confirm-time version pin cannot see `set_availability`/
  time-off changes (they append no schedule event) — the relayed commit warnings are the
  signal; the full fix (those verbs joining the event ledger) is future work. Day-0 rule:
  the freeze trims run-day windows to firm-local NOW (`bookVisit` has no past-time guard —
  only the board floors dates). Freeze input truth: pattern-less techs are INVISIBLE
  (3 of 5 active pilot techs have no pattern as of 2026-07-26 — manager sets them in chat).
- **Deferred / backlog (each has an owner-stated reason — check before resurrecting):**
  `reflow_day` batch cascade (3c); ROI/whole-plan optimization → Plan 4's freeze; jargon
  leaking into chat (conflict #1 — fix must NOT be verbatim templates); Sat/Sun "next week"
  boundary warning on `resolve_date` results — **BITTEN LIVE 2026-07-25, candidate for
  promotion; trajectory-diagnosed (session log, not inference)**: on a Saturday, "cancel Tom
  for next week's visit" missed a real confirmed **Monday Jul 27** visit. The agent did NOT
  skip the tool — it reasoned "I'm told not to do calendar math myself" and called
  `resolve_date(monday/sunday, weeksAhead:1)` → Aug 3–9, correct per the tool's own semantics
  but not what a human means by "next week" ON A SATURDAY (they mean the week starting in 2
  days — that's `weeksAhead:0`). It then HAND-ROLLED a second window "Jul 28–Aug 2" (Tue
  start, no resolve_date behind it) — GLM math sneaking back through the gap — so both
  windows excluded Jul 27, and even its clarifying question offered two wrong week-starts.
  Root causes: (a) resolve_date has NO week-range concept, forcing agent-composed windows;
  (b) weeksAhead semantics diverge from colloquial "next week" on Sat/Sun with no warning.
  Fix shape when promoted: a week mode returning {weekStart, weekEnd}, flagged ambiguous on
  Sat/Sun with BOTH candidate ranges so the clarifying question contains the right options.
  Data layer verified clean; ask-first doctrine held; agent latency (~84s serial GLM round-trips);
  Feature C (per-tenant agent memory layer); Feature D (customer/job-level L3 write path);
  Telegram unbind/offboarding (apply path is additive-only); board-auth 401 logging (PR #51
  closed unmerged — debug future 401s with the "mint-a-slip" probe: sign a fake initData slip
  with the real bot token from `.env` against the live API to discriminate server-token vs
  Telegram-side).
- **CLOSED 2026-07-31 — DeepInfra prompt caching: there is nothing "explicit" to buy, and the
  `prompt_cache_key` trial showed no measurable benefit.** Per
  [docs.deepinfra.com/chat/prompt-caching](https://docs.deepinfra.com/chat/prompt-caching)
  (re-read 2026-07-31) caching is **automatic KV-prefix reuse — "no extra parameters required"**;
  there is **no `cache_control`, no cache breakpoints, and no cache-write charge** (unlike
  Anthropic). Confirmed locally: `cacheWrite: 0` on **all 51,396 usage records across all six
  sandboxes**. The discounted read rate is applied automatically; hits arrive as
  `usage.prompt_tokens_details.cached_tokens` → OpenClaw's `cacheRead`.
  The trial flag (`compat.supportsPromptCacheKey: true`, applied to s2 on 2026-07-20; backup
  `openclaw.json.bak-cachekey-20260720`) is **still ON on s2 only** (0 occurrences on
  s3/s5/s6/s7/s8). Measured from OpenClaw session logs — **dedup by message id and read only
  `message.usage`; the `data.messages[]` / `data.messagesSnapshot[]` copies are
  whole-conversation snapshots that multiply-count by ~10×**:

  | sandbox | flag | before 07-21 | from 07-21 | 07-21 | 07-31 |
  |---|---|---|---|---|---|
  | s2 | **ON** | 20.4% (805 calls) | 63.6% (302) | 50.6% | 30.2% |
  | s7 | off | 32.2% (5) | **60.2% (132)** | **72.7%** | **46.9%** |

  s2's before/after triple reads as a win until the control is added: **flagless s7 beat flagged
  s2 on both days both were busy.** Hit rate tracks **session continuity and turn density**, not
  the key — either the OpenShell gateway strips the param or DeepInfra's automatic routing
  already covers it. **Do not roll the flag out** (it is a rebuild-drift liability — `compat` is
  re-rendered away — for zero measured gain); leaving it on s2 is harmless.
  **Prices fell ~20% since the trial** ([model page](https://deepinfra.com/zai-org/GLM-5.2/api),
  2026-07-31): GLM-5.2 is now **$0.75/1M input, $2.40/1M output, $0.14/1M cached** (was
  $0.93/$3.00/$0.18). The `cost` object in session logs reads $0.0000 — the managed gateway route
  reports no pricing, so dollars must be derived from token counts.
  **MEASURED TTL (2026-07-31) — the cache is effectively dead after ~1–5 minutes.** DeepInfra
  publishes only "cache entries expire after a period of inactivity". Measured from the session logs
  by bucketing each call on the idle gap since the previous call in the same session:

  | gap | <1 min | 1–5 min | 5–10 min | 10–20 min | 20–30 min | 30–60 min |
  |---|---|---|---|---|---|---|
  | hit rate | **68–85%** | 27–34% | 0–33% | 0–6% | **0.6–5%** (n=423) | **1.5–2.7%** (n=410) |

  **Cold starts are therefore the normal case, not the exception** — which explains both the
  48-calls/day idle poll (30-min spacing → 0.6–5%) and s2's dense testing sessions (85%).
  `prompt_cache_key` cannot fix this: it is a lookup key, not a pin, and an evicted KV cache has
  nothing to route to. **Nothing at DeepInfra lets you pin a prompt.** The comparison point is
  Google Gemini's *explicit context caching*
  ([docs](https://ai.google.dev/gemini-api/docs/generate-content/caching)) — `client.caches.create()`
  builds a named cache with a **user-chosen TTL** (default 1 h, "no minimum or maximum bounds"),
  billed on token count × storage duration; Anthropic's is weaker (`cache_control` 5-min or
  `ttl:"1h"`, paid as a 1.25×/2× write premium, reads ~0.1×). DeepInfra has neither. Its only
  native route to a persistent warm cache is a **dedicated deployment**
  ([docs](https://docs.deepinfra.com/private-models/overview.md)) — your own GPU billed per GPU-hour
  (their worked example uses $2/GPU-hour, illustrative), i.e. ~$1,400/mo for one GPU against a
  ~$18/mo fleet bill. Not viable.
  **Cache-warming pings are dead, with arithmetic:** a ~2-min TTL needs a ping every ~90 s (~960/day
  per sandbox); each re-sends the ~7.5k-token system prompt at ~$0.001, so ~$1/day/sandbox ≈ **$6/day
  fleet-wide against a $0.61/day bill**, to save at most ~$0.38/day. The 2026-07-20 research rejected
  warming on intuition; this is the measurement.
  **A real cold turn costs ~33–38k tokens** — of which **~79% is tool schemas + framing** and only
  **~21% (~7,400) is system-prompt text**. *(Correction, 2026-08-04: an earlier revision of this
  entry claimed a "19,460-token fixed floor". That was an artefact — the identical 19,460/19,467/
  19,466 minima on s2/s5/s7 were the same `nemoclaw-onboard-warmup-*` session replayed on each box,
  which loads a much smaller tool set. "Same number on three boxes ⇒ true floor" was backwards.)*
  Like-for-like real cold turns on s2 (single call, cacheRead=0, output ≤40): **37,072 / 33,176 /
  37,841** before the 2026-08-04 tool trim, **35,617** after — a spread of ±2,300, so a few-hundred-
  token change is not measurable from one sample. Schemas dominate; prose does not.
  **Do not size tool payloads from `context.compiled.tools`** — beyond being depth-limited, the trace
  record is **size-capped**: after removing six tools worth 7,837 serialized bytes the total fell only
  91,981 → 89,674, because the freed budget re-inflated other truncated schemas. Counts and names
  from that record are reliable; byte sizes are not. System-prompt sections, largest first: `## Skills` 1,225t · `## Tooling`
  943t · freeze ritual 654t · AGENTS.md header 506t · preamble 429t · dates 280t · Tool Call Style
  267t · rest ~3,100t. Note **`## Tooling` is already a brief name + one-line catalog** (19
  built-ins), and **`## Skills` (1,225t) advertises 15 stock OpenClaw plugin-skills**
  (browser-automation — with `browser` denied — plus meme-maker, notion, python-debugpy, tmux,
  weather…), none relevant to a trades business: a free cut.
  **TOOL SEARCH: TRIED AND REVERTED THE SAME DAY (2026-08-04) — it was slower AND more expensive.**
  The justification below ("first cold call 35,617 -> 10,085, -72%") measured the FIRST CALL of a
  turn and assumed a 3-call turn. Real turns run 10-14 calls, because the model must
  tool_search -> tool_describe -> tool_call instead of just calling, and every extra call re-sends
  the conversation. Measured at the TURN level on s2:

  | | direct tools | tool search |
  |---|---|---|
  | wall-clock | 4-13s | **32-139s** |
  | cost/turn | $0.025-0.035 | **$0.060-0.077** |
  | output tokens | 72-324 | **989-2,981** |

  Wall-clock on this stack is essentially **output tokens / ~34 tok/s** (held across 10 measured
  turns). The 12:48 turn ("what are the availabilities of joy") took 106.5s, of which **70.4% was
  thinking traces** — GLM thinks by default, so multiplying the CALLS multiplies the reasoning
  with it. It also burned 4 separate tool_searches discovering that no availability-READ tool
  existed (now fixed: `get_availability`).
  **MEASURED END STATE (2026-08-04 20:48, s2, the same question as the 106.5s baseline):
  17.0s / 2 tool calls / 288 output tokens / $0.0388**, against 106.5s / 14 calls / 2,966 tokens /
  $0.0770. Credit does NOT split cleanly — the turn changed two things at once (tool search
  reverted AND `get_availability` shipped) and continued a warm session: the 14→2 call drop is
  mostly the new tool, the faster per-call time mostly the revert. The clean revert-only
  comparison is the schedule question (89.2s under tool search).
  The agent relayed the server-rendered summary VERBATIM ("Joy — Tue–Sat 09:00–17:00; Mon, Sun
  off") and the fused free/busy note — both `get_availability` design bets, confirmed live.
  Reverted fleet-wide 2026-08-04: s2/s5/s6/s7/s8 `toolSearch:false`, config hash matching, zero
  stale blocks, ownership intact. **s3 was deliberately NOT wired** (the tool trim is declined
  there by owner decision) so it still lacks §0f rule 5 — the UTC-timestamp trap is LIVE on Judy's
  box; applying only the §0f block, without the trim, is the pending follow-up.
  **PROCESS TRAP hit here: PR #99 was merged BEFORE the revert commit was pushed to its branch**,
  so `main` briefly carried `toolSearch: true` and §0i/§0j while the live fleet was reverted —
  i.e. re-running `wire` from main would have re-broken a box. A merged PR does not stop taking
  commits; pushing to its branch afterwards silently leaves them unmerged. Check
  `git merge-base --is-ancestor <commit> origin/main` after any post-merge push.

  **The lesson that survives: tool COUNT was never the problem.** The 67s -> 3s win came from
  denying ONE pathological 13-deep schema (`message`, ~51s alone) — that deny list STAYS. 39 flat
  schemas are fine; the whole 8-tool READ surface is only ~1,414 tokens (~4% of a cold turn), so
  pruning tools is not where savings live. **Never re-enable without measuring whole turns
  (seconds + total tokens), never a single call.** §0i/§0j were removed with it — they are not
  merely inert without tool search, they are WRONG (they tell the agent to reach `resolve_date`
  via `tool_search`). The UTC-timestamp rule from §0j survives as §0f rule 5, and §0f is now
  REFRESHED per wire run so already-wired boxes actually receive it.
  Original (now-retired) rationale follows.
  **TOOL SEARCH WAS LIVE ON s2 (2026-08-04, since reverted).** `tools.toolSearch =
  {enabled:true, mode:"tools"}`, `skills.limits.maxSkillsInPrompt = 0`, and the extended tool deny
  are applied to s2 and codified in `Box_Setup_Stuff/bootstrap-box.sh` (the jq config block plus a
  new §0i AGENTS.md block). **Block numbering:** §0h was already taken by the freeze ritual, so the
  tool-search pair is **§0i** (describe-before-call) and **§0j** (dates under tool search). The
  appended AGENTS.md text carries NO § labels — they exist only in `bootstrap-box.sh` and these
  docs — so renumbering never requires touching a live box.
  Measured on one identical question, "what's on the schedule this week?":

  | | before tool search | tool search | + describe-before-call rule |
  |---|---|---|---|
  | first cold call | 35,617 tok | 10,085 | **10,333** |
  | model calls | ~3 (est.) | 7 | **3** |
  | turn cost | ~$0.044 (est.) | $0.0560 | **$0.0207** |

  **Tool search on its own was WORSE per turn** (7 calls, $0.056): GLM-5.2 guessed argument names and
  *retried the same guess reworded* (`{"week":"this"}` → `{"week":"this week"}`) before calling
  `tool_describe`. The §0i rule ("describe before you call; never re-guess") fixed it outright —
  7 calls → 3, cost −63%. **Never enable tool search without that block.**
  **Tool search made the agent skip a doctrine-mandated tool — DIAGNOSED, PATCHED AND
  LIVE-VERIFIED ON s2 2026-08-04 (§0j).** In the clean run the agent went straight to
  `get_team_schedule` with hand-computed dates (`2026-08-03`/`2026-08-09`) and **never called
  `resolve_date`**, which §0f requires precisely because the model is unreliable at calendar
  arithmetic (there is a real week-boundary incident behind that block).
  Root cause is not reluctance — it is that **§0f named a tool that no longer exists from the
  model's side.** Under tool search the tool list is exactly
  `[tool_search, tool_describe, tool_call]` (`toolCount: 3` in the trajectory); `resolve_date` is a
  catalog entry it has to go and find. The date eval is the control: with `resolve_date` directly
  in the tool array, the *same blunt wording* got it called **98/98**. Instruction fine, surface
  stale.
  **There is no way to pin a tool past the catalog** — verified in the running build:
  `ToolSearchSchema` is `.strict()` and accepts only `enabled`/`mode`/`codeTimeoutMs`/
  `searchDefaultLimit`/`maxSearchLimit`, and the `shouldCatalogTool` override has exactly one
  internal caller (code-mode control tools), no config path. So the fix has to be instructional.
  **Fix = §0j AGENTS.md block** (`bootstrap-box.sh` `phase_wire`, appended AFTER §0i because it
  builds on the search mechanics): names the route (`tool_search` "resolve date" → `tool_call`),
  makes it a hard rule that every YYYY-MM-DD leaving the agent came out of a `resolve_date` result,
  and closes the UTC trap below. Applied to s2/s5/s6/s7/s8 2026-08-04; **s3 excluded and unaffected
  — it has `toolSearch:false`, so §0f still describes its real surface.**
  **VERIFIED on s2 with the exact failing input** ("what's on the schedule this week?"): the turn now
  runs `tool_search` ×2 → `tool_describe` ×2 → `tool_call resolve_date {week:0}` →
  `tool_call get_team_schedule {from:2026-08-03,to:2026-08-09}`. Same two dates as the failing run,
  but sourced from the tool; it also used **week-range mode (`week:0`) rather than composing the
  Mon–Sun window itself**, which is the agent-composed-window root cause behind the 2026-07-25
  week-boundary bite closing. Answer checked against `assignments` (Mon 7 stops, Tue 8) — correct.
  **UTC trap (rule 3) VERIFIED SEPARATELY 2026-08-04 19:11 local** — that first question could not
  test it (Aug 3 local and Aug 4 UTC fall in the same Mon–Sun week, so both paths give Aug 3–9). The
  discriminating question is **"what's on tomorrow?" asked 5pm–midnight local**: UTC-derived gives
  Wed Aug 5 (16 stops), correct gives Tue Aug 4 (8 stops). Asked in a **fresh session** (no earlier
  `now` line to fall back on — the only date-shaped string in context was the wrong one), the agent
  reasoned verbatim: *"The timestamp says 'Tue 2026-08-04 02:11 UTC'. But I need to use resolve_date
  to get the correct date, as per the rules."* → `resolve_date {dayShift:1}` →
  `{date:2026-08-04, today:2026-08-03}` → 8 stops. Correct.
  **Remaining gap: s5/s6/s7/s8 carry the identical block but have not run a date-shaped turn.**
  **Schema note for anyone verifying a schedule answer against the DB: the schedule lives in
  `assignments` (`starts_at`, `status='confirmed'`), NOT in `visits`** — `visits.scheduled_at` is
  effectively unused (7 rows, all NULL), so querying `visits` makes a full schedule look empty.
  **UTC-TIMESTAMP TRAP (found while fixing the above).** Every inbound Telegram turn carries
  `"timestamp": "Tue 2026-08-04 00:57 UTC"` in the conversation-info block — the ONLY date-shaped
  string in a first-turn context, weekday included, and it is **UTC**. Both tenants are
  `America/Los_Angeles`, so from 5pm PDT / 4pm PST to midnight it names **tomorrow**: ~7 hours in
  every 24 where reading it gives a silent off-by-one. It is labelled "untrusted metadata", which
  discourages use but never says it is *wrong*. The `now` rider (`src/mcp/server.ts` `groundingNow`)
  IS firm-local — but it only arrives on a tool RESULT, so it cannot catch a first-turn date answer.
  §0j rule 3 states the trap explicitly.
  **Verification traps:** with tool search on, `context.compiled.tools` still lists all 65 tools —
  that is the session-side CATALOG, not what is sent to the model; only usage tokens prove it works.
  And the catalog moves INTO the system prompt (29,636 → 40,644 chars), so `systemPrompt` size
  measures the skills cap and tool search together and cannot separate them.
  **OpenClaw 2026.5.27 supports tool search.** Config is **top-level `tools.toolSearch`**:
  `union([boolean, {enabled, mode:"code"|"tools", codeTimeoutMs, searchDefaultLimit,
  maxSearchLimit}])`; `applyToolSearchCatalog()` swaps the tool array for
  `tool_search`/`tool_describe`/`tool_call` and keeps the catalog session-side, which would cut the
  ~12k schema payload to a few hundred tokens. **Traps:** `mode` defaults to **`"code"`** (the model
  writes code to call tools — force `"tools"`); top-level `tools.*` is the section a rebuild WIPES
  (only `agents.*` survives, see the tool-trim entry); and it inserts a retrieval step ahead of
  live-customer bookings — the real risk is accuracy, not tokens. (Search for OpenClaw internals
  **inside the container** at `/usr/local/lib/node_modules/openclaw` — it is not installed on the
  host, and a host-side grep returns a false negative.)
  **Where the spend actually is** (fleet 2026-07-21→07-31: 6.82M uncached + 10.50M cached input,
  67k output ≈ **$6.74**, **98% of it input**, 60.6% blended hit rate):
  (1) the **fixed prefix re-sent on every call** — AGENTS.md is ~26 kB (~6.5k tokens) fleet-wide
  and `bootstrapMaxChars` is now 48000 so it is no longer truncated; cached tokens still cost
  $0.14/1M, so trimming beats caching. (2) **Session hygiene** — long sessions re-buy a growing
  history every turn (s2 late-session prefixes ~110k tokens); resetting between batches is free.
  (3) **Idle polling** — s3/s5/s6 each ran **exactly 48 model calls/day from 07-14 to 07-21** in
  one long-lived session, ~24k uncached input for ~6 output tokens each (≈$0.86/day/sandbox at
  ~0% hit rate; 30-min spacing exceeds the undisclosed TTL). It stopped on its own and
  `cron/jobs.json` is `[]` everywhere now — but watch for the shape returning. Even a perfect
  100% hit rate would only save ~$4.16/11 days (62%) at today's volume. GLM-5.2 stays (owner
  decision — Nemotron quality rules out flash-tier models). Original mechanics, revert recipe and
  citations:
  [thoughts/shared/research/2026-07-20-glm52-deepinfra-cache-optimization.md](../thoughts/shared/research/2026-07-20-glm52-deepinfra-cache-optimization.md).
- **FIXED 2026-07-30 — agent turns took 60–80s; cause was ONE tool's schema.** Every request
  compiles each tool's `parameters` JSON-Schema into a constrained-decoding grammar *before the
  first token* (the router converts tools to `response_format: structural_tag`, not native
  tool-calls). Measured on s2 with the grammar forced cold: **0 tools = 1.4s, 73 tools = 67s**.
  Isolating it: `message` (an OpenClaw built-in, 113 params, 13 levels deep) costs **~51s alone**;
  `browser` ~7.7s. Neither was called ONCE in 160 stored sessions (web content goes through
  `trades-spine__read_webpage`); `cron` IS used (41 calls) so it stays. Denying the two:
  **67s → 3s cold**, ~3,900 fewer tokens/turn. Our own 39 spine tools are innocent (avg
  schema-complexity score 8 vs `message`'s 317).
  **CORRECTION 2026-07-31: the "`cron` ≈ 2.7s" figure first recorded here was WRONG** — it came
  from an n=1 bisect pair taken under the variance documented below. Re-measured properly
  (streaming TTFT, 6 rounds, ×5 amplifier, DeepInfra route verified before *and* after):
  **`cron` ≈ 180–200 ms/turn.** The 67s → 3s headline is unaffected — that was replicated 3×
  and `message` still dominates — only the per-tool cron attribution was bad.
  Proof it is the schemas and not tokens: same 73 tools with `parameters` emptied and the schema
  text moved into descriptions ran **2.7s median with MORE tokens** (41.3k vs 38.6k), replicated
  3× interleaved. Applied to s2/s5/s6/s7/s8 via `agents.list[].tools.deny` (the `agents` section
  survives rebuilds; top-level `tools.deny` does NOT — see `openclaw-config-merge.ts`
  `backupDurableSections`). **s3 (Judy) deliberately NOT touched** — originally under a hands-off
  rule, which the owner lifted 2026-07-31; asked the same day whether to apply the deny there, the
  owner declined ("she doesn't need the latency fix"). So s3 stays on the untrimmed tool surface by
  DECISION, not oversight — don't re-raise it.
  Also flipped `models…models[].reasoning: true`: while false, `agents.defaults.thinkingDefault`
  is IGNORED and every session resolves to `thinkingLevel: off`. With it true, `adaptive`
  (ranks equal to `medium`, both 30) takes effect at no measurable cost on cheap turns.
  What it is NOT (each disproven with measurements): prompt size (cold 38k prefill = 2.5s),
  prompt-cache misses (a turn with `cacheRead=38,016` still took 74.6s), streaming,
  `prompt_cache_key`, `max_tokens`, tool COUNT, or provider health.
- **2026-07-31 — a flat-schema `cron` replacement was BUILT, MEASURED, and REJECTED. Do not
  rebuild it.** `cron` is the one costly built-in the agents actually use (41 calls / 160
  sessions — the freeze-reminder path), so the plan was to replace rather than deny it: a
  plain-JS OpenClaw tool plugin (`trades-cron`, tool `cron_job`) exposing the same nine actions
  through a flat object of scalars, rebuilding the nested job in `execute` and calling the
  identical Gateway RPCs via `callGatewayTool`. Schema shape
  **6,835 B / 108 props / depth 5 → 1,899 B / 21 props / depth 2**.
  It worked — plugin loaded, tool reached the model, 12 unit tests green — but the measurement
  killed the case for it (TTFT, 6 interleaved rounds, min estimator, ×5 amplifier as a
  sensitivity control, DeepInfra route verified before *and* after, 0 failovers):

  | background | built-in `cron` | flat `cron_job` | saving/turn |
  |---|---|---|---|
  | 37 tools | 204 ms | 46 ms | ~158 ms |
  | 64 tools | 183 ms | ~0 ms (−29, unmeasurable) | ~180 ms |

  Sensitivity control passed both times (5 copies of `cron` cost +1022 ms / +913 ms over
  baseline), so the ~zero for `cron_job` is a real null, not a missing signal. **~0.2s off a ~3s
  turn did not justify a per-sandbox plugin to carry across OpenClaw upgrades** — owner decision,
  2026-07-31. Removed from s2 and from this repo; `cron` stays enabled everywhere.
  Two findings from the work are worth keeping even though the plugin is gone:
  - The built-in `cron` exposes `gatewayUrl`/`gatewayToken`, and GLM-5.2 **hallucinates them on
    most calls** (it invents a token), getting `gatewayUrl override rejected` / `pairing
    required` and burning a turn before retrying without them. Still live. A cheaper fix than a
    whole plugin, if it ever becomes worth fixing, is a line in AGENTS.md telling the agent never
    to pass them.
  - `cron` already accepts **flat params**: `recoverCronObjectFromFlatParams` in
    `dist/openclaw-tools-*.js` reconstructs `job`/`patch` from top-level keys, and the schema is
    `additionalProperties: true`. So the nested `job`/`patch` sub-schemas are redundant for the
    common cases — which is why a flat wrapper was possible at all.

  Plugin mechanics learned, if a future plugin IS warranted: OpenClaw discovers plugins from a
  **persisted cold-metadata registry**, so a new extension needs
  `openclaw plugins registry --refresh` — dropping files in `/sandbox/.openclaw/extensions/`
  alone leaves the tool invisible. `openclaw plugins inspect` showing `Tools: (anonymous)` is
  normal for the factory form (`registerTool((ctx) => …)`, which is how the bundled `browser`
  plugin gets `ctx.sessionKey` / `ctx.agentId` / `ctx.deliveryContext`); `contracts.tools` in the
  manifest is what cold discovery reads. Plugins should import nothing from `openclaw` at load
  time (the bundled `nemoclaw` extension is the working reference). Gateway RPC from a plugin
  goes through `callGatewayTool` (exported via `openclaw/plugin-sdk/agent-harness-runtime`);
  it cannot be exercised from the CLI at all — device pairing blocks it, and the built-in
  `openclaw cron` CLI hits the identical wall, so plugin RPC needs a real Telegram turn to test.
  Beware `tar` from macOS: it ships `._*` AppleDouble files into the plugin dir.
- **Dated debts:** GRANT/default-privileges migration to replace
  `auto_expose_new_tables = true` — **due before 2026-10-30** (Supabase removes the flag;
  fresh local stacks then break with `permission denied`). Old revoked NVIDIA key may still
  sit in `/root/s4-nvidia.env` on the box — refresh before the next `provision` run. Render
  `ANTHROPIC_API_KEY` was found invalid 2026-07-04 (write-path spine tools fail) — verify it
  was fixed. NOTE: since the 2026-07-25 provider switch the four spine forced-tool calls
  (classify/extract/brief/answer) use `INFERENCE_API_KEY` (GLM-5.2 via DeepInfra) by default
  (`MODEL_PROVIDER=openai`, `src/model/forcedTool.ts`); `ANTHROPIC_API_KEY` only bites when
  `MODEL_PROVIDER=anthropic`. So the on-Render key to keep valid is now `INFERENCE_API_KEY`.
- **Pending human tests:** Ben's phone board test (read-only day view, no tab bar, push on
  move); promised-visit confirm dialog via board drag; Judy items above.

- **2026-07-31 — cron was dead fleet-wide, for TWO stacked reasons. Both now fixed on s2, s3, s5,
  s6, s8 (s7 held back — in use for testing).**
  1. **Device pairing.** Every tool routed through `callGatewayTool` (`cron`, `nodes`, `gateway`,
     `wake`) reconnects to the Gateway as a *client* (`clientId=gateway-client`,
     `clientMode=backend`). OpenClaw waives pairing only for shared-secret clients on a **loopback**
     address, but NemoClaw points `OPENCLAW_GATEWAY_URL` at the bridge IP — so every call was
     refused with `pairing required`. NemoClaw's auto-approval allowlist
     (`openclaw_device_approval_policy.py`) covers `openclaw-control-ui` + `webchat`/`cli` only, so
     the agent's own client is *never* auto-approved; and `doctor --fix` deadlocks because its first
     step is a gateway-pinned `devices list`, which needs the approval it is trying to grant.
     Contributing: `openclaw.json` `gateway.port` had drifted (18790/18793) from the real port
     (**18789**), so OpenClaw's local loopback fallback — the documented escape hatch — dialled a
     dead port. **Fix per sandbox:** correct `gateway.port` (gateway-mediated recipe), then
     `nemoclaw <s> exec --no-tty -- bash -lc "openclaw cron status"` to mint the request and
     `... "openclaw devices approve <id>"` to approve it (prints *"using local fallback"*), twice —
     once for read, once for the cron-mutation scope. Verify with `doctor` → `[ok] Tool-call device
     scope`. Must be `nemoclaw exec` (gateway netns); `docker exec` lands elsewhere and loopback
     fails. Full write-up: `thoughts/shared/research/2026-07-31-nemoclaw-device-scope-deadlock.md`.
     **Note `cron.add/update/remove/run` require `operator.admin`, not `operator.write`** — and
     `operator.admin` is a universal allow (`if (scopes.includes("operator.admin")) return
     {allowed:true}`), so scheduling costs config-write/agent-delete/channel-control too.
     **That approve-based recipe only works on a sandbox that was part-paired during its startup
     window (s2). A COLD sandbox cannot be repaired that way** — every `nemoclaw exec` mints a new
     pending request that supersedes the one being approved, so it never converges. What works
     there: **seed both halves of the token pair by hand.** OpenClaw authenticates a paired device
     by *plain token comparison* (`verifyPairingToken` → `safeEqualSecret`); the stored `publicKey`
     is never used to verify a connection. The same secret lives in two files and a real approval
     writes both — `devices/paired.json` (server) and `identity/device-auth.json` (client).
     **Seeding only `paired.json` fails closed with `token-mismatch`** — the client can't present a
     token it never received. No gateway restart needed (`loadState` re-reads per auth attempt), so
     it's zero-downtime on live boxes; clear `devices/pending.json` to `{}` afterwards or `doctor`
     keeps reporting `[fail]` on an inert stale request. Script + full derivation in the research
     doc. Used on s3/s5/s6/s8 on 2026-07-31.
  2. **Main-session cron cannot fire here.** A `sessionTarget: "main"` + `systemEvent` job does not
     run itself — it wakes the heartbeat, and we set `agents.defaults.heartbeat.every: "0m"` on
     purpose. `heartbeat-runner` returns `{status:"skipped", reason:"disabled"}`, so cron records
     `status: skipped, error: "disabled"` **and flips the job to `enabled:false`** — it looks
     healthy at creation and silently never fires. **Isolated `agentTurn` jobs are unaffected** and
     were verified end-to-end: fired on time, ran a real turn, `delivered: true` to Telegram.
     The §0g AGENTS.md block now mandates `sessionTarget:"isolated"` + `payload.kind:"agentTurn"`
     and is REFRESHED per wire run (delete-then-append) instead of append-once.
- **AGENTS.md is ~26.6k chars against a 12k injected-context budget, so most of it never reaches
  the model.** Truncation keeps head 45% + a policy digest 35% + tail 15%
  (`trimAgentsBootstrapContent`). The digest scans the whole file but caps lines at **240 chars**
  and fills its 4,200-char budget in **file order**: s2 has 56 high-priority (`must`/`never`/`do
  not`) lines totalling 4,900 chars, so **135 policy lines are dropped** and anything late in the
  file loses. The new cron rule survives only because its block is currently last (tail) and its
  imperative is a single ≤240-char line — deliberately written that way. **Any operator guidance
  added late in AGENTS.md is probably invisible; verify with the head/digest/tail model before
  trusting it.** Trimming AGENTS.md is the real fix and is still owed.

## 5. The walls — traps by the time you'd hit them

The box-side details live in `Box_Setup_Stuff/` (setup guide §8 gotchas, architecture-memory
"Gotchas") — this is the index of what exists, so you know to go look.

**Working on the agent boxes:**
- **A tool DESCRIPTION change is not deploy-only; a result-side field is.** Gateways cache
  `tools/list` per process, and descriptions are part of that payload — so editing one needs
  `nemoclaw <s> gateway restart` before any agent sees it, while adding a field to a tool's
  *result* (PR #83's grounding riders; the 2026-07-31 per-stop `mapsUrl`) goes live on deploy
  alone. A full box wire re-run is only needed when the change also touches AGENTS.md contract
  text or the pinned tool NAMES — a pure description edit touches neither. **And the restart is
  per TIER, not fleet-wide:** a tool filtered off one surface only forces restarts on the tier
  that carries it. Worked example (2026-07-31) — the `get_schedule` rewrite changed that tool's
  description, but `get_schedule` is filtered out of `MANAGER_TOOLS`, so *technician* sandboxes
  needed the restart and the manager side, whose change was result-only, was live the moment
  Render deployed. Getting this backwards costs either a stale fleet or needless restarts.
  **Amended 2026-08-04, after the tool-search rollout (PR #99):** under `tools.toolSearch` a
  description is no longer only the parameter surface — it is the **discovery surface**. The
  model's loaded tool list is just `tool_search`/`tool_describe`/`tool_call`; every spine tool is
  a catalog entry it has to *find*, by matching against that description text. So a description
  edit now changes both what the agent can learn about a tool and whether it locates it at all,
  and the gateway's per-process `tools/list` cache still gates when either takes effect. The
  matching failure is silent and total — that is exactly how `resolve_date` stopped being called
  (§0j in `bootstrap-box.sh` teaches the route explicitly as the fix). **Any tool whose
  description you rewrite inherits that exposure**; `get_schedule` was rewritten on 2026-07-31
  and has no §0-style block of its own, so "the agent never called it" is a live failure mode to
  rule out before blaming the tool.
- **A sandbox can hold a badge the doorman no longer knows — and nothing says so.** Found on s5
  2026-08-04: every spine call returned the doorman's flat `badge not authorized`, while
  `badges.json` held a live, non-revoked entry for that very person (`ben-shelton`). The sandbox
  was simply carrying an OLDER badge — the pull regenerates `badges.json` wholesale from the
  roster, so a rotation orphans whatever the sandbox still has. There is no error surfaced to the
  operator, no unhealthy status, and the container/gateway both report healthy; the bot just
  cannot reach any tool. **Diagnostic (verified, fingerprints only — never print plaintext):**
  fingerprint the badge from BOTH `/sandbox/.openclaw/openclaw.json`
  (`.mcp.servers["trades-spine"].headers.Authorization`, strip the `Bearer ` prefix) and the
  running gateway's `/proc/<pid>/environ` `TRADES_SPINE_BADGE`, then test
  `jq --arg f "$FP" 'has($f)' /etc/doorman/badges.json`. Both fingerprints matching each other but
  absent from `badges.json` = orphaned badge, and it also proves a gateway restart did not cause
  it (the file and the live process agree). Fix is server-side `rotate-badge` → next pull mints
  into `/root/pending-badges.jsonl` → install as the provider credential → **container** restart
  (a gateway restart is not enough; creds inject at container launch). Check this BEFORE
  debugging any "the agent isn't using tool X" report on a specific sandbox.
- **Credentials inject into a sandbox's process env at container launch ONLY.** Any provider
  credential write (badge install/rotation, token change) needs a container restart to take
  effect. This exact mechanism silently killed Judy's spine MCP for 4 days (badge in store,
  absent from env).
- **NEVER change a sandbox's `openclaw.json` with `openclaw config patch`.** It writes the file
  but does NOT update nemoclaw's `.config-hash`, so the next `gateway restart` fails
  `GATEWAY_UNSAFE_CONFIG_PATH` and leaves the gateway DOWN (3 bots went down learning this on
  2026-07-30). Two extra teeth: run as root via `docker exec` and the file ends up `root:root`,
  which the gateway also refuses (`chown sandbox:sandbox` + `chmod 660` to fix); and without a
  login shell `OPENCLAW_HOME` is unset, so the patch silently lands in `/root/.openclaw/` and
  changes NOTHING — it still prints "Applied N config update(s)". **Always verify by reading
  `/sandbox/.openclaw/openclaw.json` back, never trust the success message.**
  Use the gateway-mediated recipe instead (already in `bootstrap-box.sh`, heartbeat + tool-trim
  blocks): `nemoclaw <s> download` → edit with `jq` → `upload` → write `.config-hash` →
  `chmod 660` → `gateway restart`. If a gateway is already stuck this way,
  `nemoclaw <s> doctor --fix` then restart clears it.
  **The ownership tooth bites specifically on ATOMIC REPLACE (learned 2026-08-03 — s5/s6/s7/s8 all
  went down for ~2 min).** A root-side write *in place* (`open(path,"w")`) truncates the existing
  inode and **keeps** `sandbox:sandbox`, so it works. Rewriting the same script to be "safer" —
  write `path.tmp`, then `os.replace()` — creates a **new inode owned by root**, and
  `shutil.copymode()` copies the mode but **not the owner**, so `ls` still shows `-rw-rw----` and
  nothing looks wrong. `chmod` is not a substitute for `chown`: after ANY root-side write, run
  `chown sandbox:sandbox` and check the **owner** column, not just the permission bits, before
  restarting. The failure is at least loud and instant — every restart returns
  `GATEWAY_UNSAFE_CONFIG_PATH`, and chown + restart is the whole recovery.
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
- **DeepInfra balance runs out roughly monthly and NOTHING alerts on it** — 2026-07-11,
  2026-07-20, and again **2026-07-31** (last healthy probe 07:15:53Z, failover 07:20:57Z, still
  failed over 8h24m later). Each time medic v2 failed the fleet to `nvidia-prod` within one tick
  and the bots kept working (0 model errors on s2 across 9h), which is exactly why it goes
  unnoticed. Surface it with the medic's own probe run LOUD:
  `openshell inference set -g nemoclaw --provider deepinfra-prod --model zai-org/GLM-5.2` —
  the 402 body names the cause. Auto-top-up / a balance alarm is still not configured.
- **`inference.local` silently follows the failover, so a provider flip INVALIDATES any latency
  measurement taken across it.** A `cron_job` A/B on 2026-07-31 was ruined this way: samples
  before 07:20 hit DeepInfra (~1.5–10s), samples after hit NVIDIA (5.9–45s, then HTTP 429s on
  the measurement traffic itself). Run `openshell inference get` **before and after** any timing
  run and discard the run if it changed. NVIDIA rate-limits ad-hoc measurement traffic well
  before it affects the bots — a 429 on your own probe is not evidence the agents are degraded.
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
