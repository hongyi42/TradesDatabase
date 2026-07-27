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
  the human yes — ritual doctrine untouched); follow-up feature, scope/timing pending
  owner decision.** REMAINING: the Pinned-chip phone check, then the plan flips complete
  (the readability box closes as done-with-finding).
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
  was fixed. NOTE: since the 2026-07-25 provider switch the four spine forced-tool calls
  (classify/extract/brief/answer) use `INFERENCE_API_KEY` (GLM-5.2 via DeepInfra) by default
  (`MODEL_PROVIDER=openai`, `src/model/forcedTool.ts`); `ANTHROPIC_API_KEY` only bites when
  `MODEL_PROVIDER=anthropic`. So the on-Render key to keep valid is now `INFERENCE_API_KEY`.
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
