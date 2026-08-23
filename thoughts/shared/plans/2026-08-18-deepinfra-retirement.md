---
date: 2026-08-18
task: Retire DeepInfra at level D — repoint the fleet to Fireworks, build an outage notifier, strip the code, delete the registration
research: thoughts/shared/research/2026-08-18-deepinfra-retirement.md
status: draft
---

## Overview

Make the box agree with Render (both on Fireworks), then remove DeepInfra entirely: the
provider registration, its credential, and the code paths. Because this leaves the fleet
single-provider with no fallback, the work **starts** by building the missing alarm — today
nothing tells a human the fleet is down — and only reaches the irreversible step once the
alarm is proven and the recovery runbook is written and drilled.

## Decisions

- **Removal depth = level D (everything)** — user decision. Repoint + fix the stale
  bootstrap + delete the `deepinfra-prod` registration + strip code paths.
- **DB rows STAY: `cost_rates` (3 deepinfra rows) and `infra_costs` (July $43.13, August
  $22.59) are not touched.** Level D removes *code*, not history. The rollup prices history
  by joining `cost_events`↔`cost_rates` in SQL — deleting those rate rows would make July/
  August un-priceable *and* break the netting step, over-allocating the $43.13 invoice.
  Keeping them costs nothing and leaves `costs.test.ts:205-234` green unchanged.
- **Recovery lane = billing-first, no retained DeepInfra key** — user decision. The runbook
  leads with the Fireworks fix (raise the cap / clear the 412 suspension), which is the only
  lever that actually applied on 2026-08-15. A backup provider lane is **deferred to the move
  into production**, explicitly not dropped.
- **Notifier fires from the `/control/ops` handler, not a cron poll** — implementation call.
  `recordOpsEvent` already collapses repeats into exactly-once transitions (`opened` /
  `closed`), so the handler is the only place with a de-duplicated signal. A cron poll would
  need a new `notified_at` column plus a migration and would add up to 5 minutes of latency.
  The web service already carries `BOARD_BOT_TOKEN`.
- **Notifier is service-agnostic** — it alerts on any `ops_events` transition, not just
  `inference-medic`, so future producers get alerting free. Alerts on close too ("it's back").
- **A push failure must never fail the ops report** — wrapped in try/catch, logged only.
  Same doctrine as `ops-report.sh`: monitoring must never break what it watches.
- **Code defaults move to Fireworks.** `DEFAULT_OPENAI_BASE_URL` / `DEFAULT_OPENAI_MODEL`
  currently point at DeepInfra, so an unset env silently targets a soon-dead endpoint.
- **`nvidia-prod` is left alone** — out of scope; nothing routes to it.
- **August freezes as an `estimate`.** DeepInfra settles a month in early September; removing
  the collector now means August's $22.59 never flips to `invoice`. Accepted (project is in
  development); the runbook records the one-line `upsertInfraCost` correction path.
- **Ordering: alarm → flip → runbook+drill → code removal → registration delete.** The
  irreversible step runs last, after the recovery procedure exists and has been drilled.
- **Fireworks is pay-as-you-go, not a fixed monthly cap** (user, 2026-08-18) — the limit
  rises with use, so there is no cap to "raise".
- **An outage is ACCEPTABLE and the balance is NOT a gate** (user, 2026-08-18, stated twice).
  This is a testing environment with no live users: a balance-out affects nobody and costs
  only a top-up. Hence no flip window, no balance gate, and no further cost-risk escalation.
  This changes at the move into production — the same milestone that owes the backup lane.

## Plain-language walkthrough

**Today** two systems each pick which AI company serves them, and they disagree — the six
technician sandboxes on the box use DeepInfra, Render's server uses Fireworks. We are making
both use Fireworks and then removing DeepInfra completely.

```
BEFORE                                    AFTER
 box  ──► DeepInfra                        box  ──┐
 Render ─► Fireworks                       Render ┴──► Fireworks   (no fallback)
                                                        │
 outage ──► medic notices ──► DB row ──► ✗ nobody       └─ outage ──► medic ──► DB ──► 📱 you
```

**Phase 1 — build the alarm.** Right now the box's health checker notices an outage within
5 minutes and writes it to a database table that *nothing reads*. Eleven outages in six days
were all invisible. We add the missing half: when an incident opens, the server sends you a
Telegram message; when it closes, it sends the all-clear. This goes first, deliberately —
you install the smoke detector before you remove the sprinklers.

**Phase 2 — flip the box.** One script on the box, `nemoclaw-inference-medic.sh`, holds the
choice of provider and re-asserts it every 5 minutes. We install the repo's version (which
already says Fireworks) plus the box's provisioning script, which is one change behind and
still says DeepInfra. You'd notice it working because a real technician question gets a real
answer, and the medic's log line names Fireworks.

**Phase 3 — write and drill the recovery runbook.** A written procedure for "Fireworks is
down and every assistant is dead", aimed at a person under pressure. We *test* it by firing a
fake outage report at the server and confirming a Telegram alert actually arrives, then
confirming the all-clear closes it.

**Phase 4 — remove the code.** Delete the DeepInfra bill collector, its cron step, and its
entries in the pricing and routing tables. Historical cost rows stay put and stay priced.

**Phase 5 — delete the registration.** The point of no return: the stored DeepInfra key is
write-only, so once deleted it cannot be read back. Last, and only once everything above is
proven.

## Secrets & env preflight

- **Phase 1:** `OPS_ALERT_CHAT_ID` — **NEW**, on the Render **web service**
  (`srv-d8uqmdegvqtc73bfn83g`). Value = **`5801703167`** (operator's Telegram user id,
  supplied 2026-08-18). Requires an existing 1:1 chat with `@DashboardMan_bot` — if none
  exists, the send 403s; press Start there first.
  `BOARD_BOT_TOKEN` — `already required` on the web service.
- **Phase 2:** none new. Needs `ssh tradesbox` + `sudo` (privileged install — expect to run
  the one-liner yourself; Claude Code's auto mode blocks it).
- **Phase 3:** none.
- **Phase 4:** removes the need for `DEEPINFRA_BILLING_API_KEY` on the lifecycle cron
  (`crn-d93iq7a8qa3s73ap6260`) — delete it as cleanup **after** the PR deploys.
- **Phase 5:** none.

**No blocking gate.** ~$9.60 remains on Fireworks (2026-08-18). At roughly $1.8–$8.8/day of
fleet traffic that is on the order of days, not weeks — but **this is a testing environment
with no live users, and the user has ruled that a balance-out affects nobody and costs only a
top-up** (stated twice). So: do not treat the balance as a gate, do not hold the flip on it,
and do not re-raise it. Phase 1's notifier is what surfaces it when it happens.
*(Context for whoever tops it up: fleet cache hits are replica luck — the gateway cannot
inject `prompt_cache_key` — so the fleet's rate sits above the spine's.)*

---

## Phase 1: The outage notifier

### What this phase does
Adds the missing reader on `ops_events`: when an incident opens or closes, push a Telegram
message to the operator. Fires from the `/control/ops` handler, where `recordOpsEvent`
already produces exactly-once transitions.

### Changes required

**`src/telegram/opsNotify.ts`** (new)
- `export async function notifyOpsTransition(outcome: OpsOutcome, service: string, host: string, detail?: Record<string, unknown>, deps?: { send?: typeof sendBoardMessage }): Promise<void>`
- Import `OpsOutcome` from `../db/opsEvents.js` — it is **not** re-exported from
  `src/db/index.ts` (same import path `httpServer.ts:20` already uses).
- The `deps.send` seam is load-bearing, not optional: `httpServer.test.ts` is a real-HTTP
  integration test (`createHttpServer()` at :49) with no other injection point.
- `host` is passed in rather than hardcoding `trades-box-1` — `handleOpsReport` has `host`
  in scope at [httpServer.ts:438](../../../src/mcp/httpServer.ts#L438), and the notifier is
  service- and host-agnostic by design.
- Returns immediately unless `outcome.action` is `'opened'` or `'closed'`.
- Returns immediately (no throw) when `OPS_ALERT_CHAT_ID` or `BOARD_BOT_TOKEN` is unset —
  same skip-cleanly idiom as the cron's key gates.
- Copy — plain, no jargon, and it must say what to do:
  - opened: `⚠️ ${service} is DOWN on trades-box-1.` + `route: ${detail.route}` when present
    + `Agents may be unable to answer. Runbook: docs/inference-recovery-runbook.md`
  - closed: `✅ ${service} recovered after ${minutes} min.`
- Uses `sendBoardMessage` from `./boardBot.js` ([boardBot.ts:55](../../../src/telegram/boardBot.ts#L55)).

**`src/mcp/httpServer.ts`**
- Import `notifyOpsTransition`.
- At [httpServer.ts:480](../../../src/mcp/httpServer.ts#L480), after `recordOpsEvent` returns
  and **after** `json(200, outcome)` is sent — so a slow Telegram call cannot delay the
  reporter:
  ```ts
  const outcome = await recordOpsEvent({ hostId: host.id, service, status, detail });
  json(200, outcome);
  // Alerting must never break what it watches: the reporter already has its 200.
  try {
    await notifyOpsTransition(outcome, service, host.name, detail);
  } catch (err) {
    console.error('[ops] alert push failed', err);
  }
  ```
  Placement verified against the handler's control flow: `json(200, …)` calls `res.end()`,
  so the reporter has its response before the await, and the inner try/catch keeps the
  outer `catch { … 500 }` clean.

**`src/telegram/opsNotify.test.ts`** (new) — inject a fake sender:
- `opened` → one message, contains the service name and the runbook path
- `closed` → one message, contains the elapsed minutes
- `suppressed` / `noop` → **zero** messages (the anti-spam invariant)
- `OPS_ALERT_CHAT_ID` unset → zero messages, no throw
- sender throws → `notifyOpsTransition` still rejects, but `httpServer` swallows it

**`src/mcp/httpServer.test.ts`** — extend the existing `POST /control/ops` block
(:285-390): assert a `down`-then-`down` sequence produces exactly **one** notification, and
that a sender that throws still yields HTTP 200.

⚠ **`vi.mock('../telegram/boardBot.js', …)` is MANDATORY in this file** (precedent:
[src/calls/notify.test.ts:5](../../../src/calls/notify.test.ts#L5)). `src/test.setup.ts`
loads `.env` before `.env.test`, and `.env` carries a **real** `BOARD_BOT_TOKEN`. Today the
notifier skips because `OPS_ALERT_CHAT_ID` is unset — but the moment anyone sets it locally
to exercise this phase, `npm test` would fire real Telegram messages at the operator, since
that block posts `down`/`ok` repeatedly.

### Automated verification
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test`
- [x] new `opsNotify.test.ts` passes (5 cases above)
- [x] `httpServer.test.ts` ops block passes with the added assertions

### Live verification (agent-executable)
- Prerequisites: Render MCP (deploy + logs), `supabase-test` MCP (read-back).
- [x] **Deploy the web service explicitly first.** `srv-d8uqmdegvqtc73bfn83g` has
  **auto-deploy OFF**, and saving an env var redeploys the *old* commit — use **Manual
  Deploy → latest commit**, then confirm the deployed commit SHA carries the notifier.
  Skipping this makes the drill fail against a build with no notifier, which reads as an
  alerting bug rather than a missing deploy.
- [x] From the box: `sudo /usr/local/sbin/ops-report.sh ops-drill down` → expect a Telegram
  message; read back `select * from ops_events where service='ops-drill'` and capture the
  opened row.
- [x] `sudo /usr/local/sbin/ops-report.sh ops-drill down` again → **no second message**
  (outcome `suppressed`); row count still 1.
- [x] `sudo /usr/local/sbin/ops-report.sh ops-drill ok` → all-clear message; `closed_at` set.

*Note on `detail.route` — BOTH things are true, settled by the live drill 2026-08-19:*
- *Rows written by the **medic's systemd unit** DO carry it (e.g. `"deepinfra-prod /
  zai-org/GLM-5.2"`), because the unit runs `ops-report.sh` as **ubuntu** via
  `EnvironmentFile=`, where `openshell inference get` resolves.*
- *Rows from a **hand-run `sudo ops-report.sh`** do NOT: root gets a different HOME and
  config, which is the trap documented in ops-report.sh's own header. The drill reproduced
  exactly that — `detail` was `{"reportedBy":"ops-report.sh"}` alone.*

*So the alert's `route:` line is exercised by Phase 3's unit-driven drill, not by Phase 1's
hand-run one. (An intermediate edit here claimed the root-run caveat was wrong; it was not.)*

### Manual verification
- [x] The alert reads clearly on a phone at 2am — names the problem and points at the runbook.
      **CONFIRMED 2026-08-19: exactly two messages arrived** (⚠️ down, ✅ recovered) — the
      suppressed tick in between stayed silent, proving the anti-spam property end to end,
      not just server-side.

---
*Pause after this phase — Manual verification is non-empty.*

## Phase 2: Flip the box to Fireworks

### What this phase does
Installs the repo medic (which already says Fireworks) and the current `bootstrap-box.sh`,
then confirms every seat serves through a real tool call.

**Prerequisite:** the Fireworks **balance gate** above. No flip window needs negotiating —
the user has accepted that an outage in the testing environment is tolerable — but note this
moves all six live seats at once; there is no per-seat route.

### Changes required
No repo changes. Two privileged installs on `trades-box-1`, handed to the user as one-liners.

1. **Stop the timer first** — it re-asserts `WANT_*` every 5 minutes and will otherwise
   revert a hand-run flip:
   ```
   sudo systemctl stop nemoclaw-inference-medic.timer
   ```
2. **Capture the current ownership/mode first, and preserve it.** The unit runs as
   `User=ubuntu` ([nemoclaw-inference-medic.service:20](../../../Box_Setup_Stuff/nemoclaw-inference-medic.service#L20)),
   so installing the medic `-m 700 -o root -g root` would make it unexecutable by ubuntu and
   the unit would fail `203/EXEC` on every tick — silently ending route-healing.
   **Verified on the box 2026-08-18: both files are `root:root` mode `755`.**
   ```
   sudo stat -c '%n owner=%U group=%G mode=%a' /usr/local/sbin/nemoclaw-inference-medic.sh \
                                               /usr/local/sbin/bootstrap-box.sh
   sudo install -m 755 -o root -g root nemoclaw-inference-medic.sh /usr/local/sbin/
   sudo install -m 755 -o root -g root bootstrap-box.sh /usr/local/sbin/
   ```
3. **Verify by md5 of the path `ExecStart` names** — never a sibling copy:
   ```
   md5sum /usr/local/sbin/nemoclaw-inference-medic.sh   # expect 0921ab1e21d88a4ef38a1da4c044fc0f
   md5sum /usr/local/sbin/bootstrap-box.sh              # expect 973afe2f19a1d2bade8fb3b334444db0
   ```
   *(Correction to the briefing: these two files are 755, so a plain `md5sum` works and
   `sudo` is not required. Only `nudge-runner.sh` is mode 700 — that is where the
   "fails like not-installed" trap actually lives.)*
4. **Run the medic once by hand** — its registration gate live-verifies the Fireworks
   credential *before* saving, so a suspended key fails here and leaves the route on
   DeepInfra:
   ```
   sudo -u ubuntu /usr/local/sbin/nemoclaw-inference-medic.sh; echo "exit=$?"
   ```
   Expect `route OK on fireworks-prod / accounts/fireworks/routers/glm-5p2-fast — serving
   verified (tool call returned)` and `exit=0`.
5. **Restart the timer:** `sudo systemctl start nemoclaw-inference-medic.timer`

**Rollback, known before starting — one command, ~1 min:**
```
sudo systemctl stop nemoclaw-inference-medic.timer
sudo sed -i 's|^WANT_PROVIDER=.*|WANT_PROVIDER="deepinfra-prod"|; s|^WANT_MODEL=.*|WANT_MODEL="zai-org/GLM-5.2"|' /usr/local/sbin/nemoclaw-inference-medic.sh
sudo -u ubuntu /usr/local/sbin/nemoclaw-inference-medic.sh && sudo systemctl start nemoclaw-inference-medic.timer
```
(Valid only until Phase 5 deletes the registration — that is what Phase 5 gives up.)

### Automated verification
- [x] `npm test` still green (`inferenceMedicScript.test.ts` already pins `fireworks-prod`
      — 9/9 passing at baseline, so the installed file is test-verified in advance)
- [x] `openshell inference get -g nemoclaw` reports `fireworks-prod` /
      `accounts/fireworks/routers/glm-5p2-fast`
- [x] Two consecutive medic ticks in `journalctl -u nemoclaw-inference-medic.service` say
      "serving verified"

### Live verification (agent-executable)
- Prerequisites: `ssh tradesbox`, `supabase-test` MCP for cross-channel read-back.
- [x] **A REAL TOOL CALL through a seat** (the definition of done, and the medic's own
      doctrine that a probe not calling a tool proves nothing). Use the PROVEN harness form
      (`scripts/date-eval/run.mjs:231`), base64'd to dodge the recorded `-m` newline trap:
      ```
      nemoclaw s2 agent --agent main --session-id <sid> -m "$MSG" </dev/null 2>&1
      ```
      **Correction to an earlier draft of this plan: `--agent main` IS correct.** The memory
      note it misread warns against a turn with no EXPLICIT SESSION ID, not against the flag;
      the date-eval harness has used this exact form for every run. Never pass `--deliver`
      (s2 is the operator's own Telegram). Read the answer from the TRAJECTORY
      (`docker exec <cid> cat /sandbox/.openclaw/agents/main/sessions/<sid>.jsonl`), never
      CLI stdout — stdout carries config-warning chrome and has silently rotted before.
- [x] Cross-channel read-back. **Correction: do NOT look for `provider='fireworks'` rows.**
      Box agent turns do not write model-token events — only the Render spine does. The
      correct signal that the agent reached the spine and called a tool is:
      `select provider, sku, quantity, occurred_at from cost_events where provider='spine'
      and occurred_at > now() - interval '30 minutes';`
- [x] No incident opened: `select * from ops_events where closed_at is null`.


**Evidence captured 2026-08-19:**
- Flip ran clean: `route OK on fireworks-prod / accounts/fireworks/routers/glm-5p2-fast —
  serving verified (tool call returned)`, exit 0. The box's Fireworks credential — unused
  since the 2026-08-15 suspension — served on first use.
- Installed md5s: medic `0921ab1e…`, bootstrap `973afe2f…`, both `root:root 755` (preserved).
- Two consecutive post-flip ticks 06:45:03 and 06:50:14 UTC, both "serving verified".
- Real tool call through s2: `trades-spine__resolve_date` → `2026-08-21`, answered
  "This coming Friday is **Friday 2026-08-21**." Trajectory 6.0s (wall 22s incl. ssh).
- Cross-channel: one `spine / tool_call` cost event at 06:43:43.333Z, landing between the
  tool call and its result. `ops_events` open incidents: 0.
- Fireworks prefix caching confirmed live: turn 2 read 36,744 cached input tokens.

⚠ **TRAP FOUND — the trajectory does NOT attribute the provider.** It records
`provider:"inference", model:"z-ai/glm-5.2"` and the CLI banner prints "NVIDIA Endpoints".
Those are the gateway's managed-route labels, not upstream attribution. Provider proof comes
only from `openshell inference get` plus the medic's probe. Anyone reading the trajectory's
`model` field as the provider check gets a WRONG answer — the same id-spelling trap already
recorded for `expectedModel`.

### Manual verification
- [x] One live technician-style exchange in Telegram reads normally (latency, tone).
      **CONFIRMED by the operator 2026-08-19.** PHASE 2 COMPLETE.

---
*Pause after this phase — Manual verification is non-empty.*

## Phase 3: Recovery runbook + alarm drill

### What this phase does
Writes the billing-first recovery procedure and drills the detection→alert chain end to end.

### Changes required

**`docs/inference-recovery-runbook.md`** (new) — written for a person under pressure, not
for its author. Contents, in order:
- **Symptom**: technicians report the assistant is silent / Telegram shows a generic error.
- **Confirm in 30 seconds**: `journalctl -u nemoclaw-inference-medic.service -n 20` and
  `openshell inference get -g nemoclaw`.
- **Read the failure code.** Fireworks has (at least) **two** money failure shapes and the
  runbook must name both, because the fix differs:
  - **412 `PRECONDITION_FAILED` — "Account … is suspended"** = spend limit tripped
    (observed live 2026-08-15, on the models list *and* completions).
  - **Balance exhausted** — Fireworks is pay-as-you-go here; the runbook must state the
    exact status code and body. ⚠ **Do not write this from memory — verify against
    Fireworks' current error-code documentation and CITE the URL in the runbook**
    (CLAUDE.md's external-services rule). DeepInfra's 402 shape is gone along with the lane.
- **The fix**: top up / raise the limit at fireworks.ai/account/billing. This is the only
  lever; there is no fallback provider by design (deferred to production).
- **Check the balance FIRST**, before suspecting anything technical — the balance-out
  doctrine now applies to Fireworks. In the testing environment the fix is simply to top up.
- **Expectations, from the measured record**: 11 incidents in 6 days, average 57 min, worst
  517 min; the 2026-08-15 suspension ran **69 min**. Most clear themselves — the medic holds
  the route asserted precisely so recovery is picked up by live turns immediately.
- **Do NOT**: `openclaw config patch` (downs the gateway); hand-run `openshell inference set`
  without stopping the medic timer first; health-check via `nemoclaw <n> agent`.
- **Ledger footnote**: August's DeepInfra figure is frozen as an `estimate` ($22.59); correct
  it later via `upsertInfraCost` ([costs.ts:331](../../../src/db/costs.ts#L331)) if the
  settled invoice matters.
- **Know the alarm's limit — it is AT MOST ONCE, not guaranteed** (surfaced by the Phase 1
  review). A transient Telegram failure loses that alert permanently: it is logged and never
  retried, and every later tick returns `suppressed`, so nothing re-fires. A silent channel
  therefore looks identical to a healthy fleet. Until that is addressed, treat "no alert" as
  weak evidence and check `ops_events` directly when in doubt:
  `select * from ops_events where closed_at is null;`
- **Deferred**: a backup provider lane, to be stood up at the move into production.

**`docs/engineering-memory.md`** — link the runbook from the agent-model section (~line 240).

### Automated verification
- [x] `npm run lint` (markdown untouched by lint, but the gate must stay green)

### Live verification (agent-executable)
- Prerequisites: `ssh tradesbox`, Render logs MCP, `supabase-test` MCP.
- [x] **Drill the real chain** using the medic's own unit so `OnFailure=` fires. Write the
  drop-in directly — `systemctl edit --force` spawns `$EDITOR` and hangs over ssh:
  ```
  sudo mkdir -p /etc/systemd/system/nemoclaw-inference-medic.service.d
  printf '[Service]\nEnvironment=MEDIC_PROBE_TIMEOUT=1\n' | sudo tee /etc/systemd/system/nemoclaw-inference-medic.service.d/drill.conf
  sudo systemctl daemon-reload && sudo systemctl start nemoclaw-inference-medic.service
  ```
  Expect: `curl -m 1` times out → retry also misses → medic re-asserts the route, warns, and
  exits 1 → `OnFailure=ops-report-medic-down.service` → incident opens → **Telegram alert
  arrives**. The route is NOT moved (`set_route` is unaffected by the probe timeout), so
  this is safe on a live fleet.
- [x] **Undo explicitly** (both steps — a forgotten `daemon-reload` leaves the drill armed):
  ```
  sudo rm -rf /etc/systemd/system/nemoclaw-inference-medic.service.d
  sudo systemctl daemon-reload && sudo systemctl start nemoclaw-inference-medic.service
  ```
  → all-clear message, `closed_at` set.
- [x] Capture both messages and the `ops_events` rows as evidence.


**Evidence captured 2026-08-19:**
- Runbook written and pushed to main as `f8ddfff` (doc-only, per CLAUDE.md).
- **Vendor codes verified against live docs, and they CORRECT our memory.** Fireworks
  documents 402 = "not on a paid plan or has exceeded usage limits", 412 = "account is
  suspended or there's an issue with account status … also occurs when attempting to invoke
  a LoRA model that failed to load". Memory had recorded 412 as "the monthly spend cap".
  Cited in both the runbook and engineering-memory.
- **First drill attempt FAILED TO FAIL** — `MEDIC_PROBE_TIMEOUT=1` still passed, because
  Fireworks with a warm cache serves the probe in under a second (the medic's header records
  1.9–9.9s, measured on DeepInfra). Re-armed at `0.01`. Worth keeping: a drill that quietly
  does not exercise the failure path is worse than no drill.
- **Drill fired correctly:** `fireworks-prod IS NOT SERVING … AGENTS ARE DOWN` → exit 1 →
  `OnFailure=` → `ops-report: reported inference-medic=down -> {"action":"opened"}`,
  incident `e578c644`. Recovery closed it 23s later (`openMs: 22814`).
- **The route was HELD on fireworks-prod throughout** — never moved, exactly as designed.
- `detail.route` populated on both open and close (`fireworks-prod / accounts/fireworks/
  routers/glm-5p2-fast`) — the systemd unit runs ops-report as `ubuntu`, so the alert's
  `route:` line IS exercised here, unlike Phase 1's root-run drill.
- Drop-in removed by the `trap` and confirmed absent; `Environment=` shows no override.

### Manual verification
- [x] A person who did not write the runbook can follow it start to finish without asking a
      question. This is the phase's actual acceptance test.
      **Accepted by the operator 2026-08-19** (go-ahead given; no defects raised). Also
      confirmed live from the operator's screenshot: both alerts arrived with the `route:`
      line rendered and the sub-minute copy correct. PHASE 3 COMPLETE.

---
*Pause after this phase — Manual verification is non-empty.*

## Phase 4: Strip the DeepInfra code paths (PR)

### What this phase does
Removes the collector, its cron step, and DeepInfra's entries in the routing/pricing maps.
Run **after** one quarter-hour cron tick has recorded August's final figure post-flip.

### Entry gate (blocking — do not start without this)
**Confirm `Calls-worker` (`srv-d9qelh710e5c739hb8vg`) and `Board_Worker`
(`srv-d9dr8iurnols73d1tjq0`) carry the Fireworks `INFERENCE_*` vars.** `Calls-worker` runs
`classifyCall`, a real model call. If either still points at DeepInfra when the
`ledgerVendor()` branch and `MODEL_SKUS.deepinfra` are removed, its calls record **nothing**:
the throw at [costs.ts:181](../../../src/db/costs.ts#L181) lands in the swallowed catch at
:214-216. That is a silent cost under-report — exactly the failure the ledger exists to
prevent. Requires a dashboard check; the MCP surface has no env-var read.

### Changes required

**`src/telegram/opsNotify.ts`** — BUNDLED COSMETIC FIX (found in the operator's Phase 3
screenshot, 2026-08-19): Telegram **auto-linkifies** `docs/inference-recovery-runbook.md`
into a tappable link, because `.md` is Moldova's TLD and the path parses as a domain. The
link resolves to nothing — a dead link is the worst thing to hand someone mid-incident.
Drop the extension in the alert copy: `Runbook: docs/inference-recovery-runbook`. Update the
matching assertion in `opsNotify.test.ts`. Bundled here rather than shipped as its own PR +
deploy cycle, since this phase already needs both.

**Delete** `src/model/deepinfraUsage.ts` and `src/model/deepinfraUsage.test.ts`.

**`src/jobs/lifecycle.ts`**
- Remove the import block :13-17 (`billingApiKey`, `collectDeepinfraUsage`, `CollectResult`).
- Remove deps `collectDeepinfra` :76 and `hasBillingKey` :77-79.
- Remove `deepinfraUsage` from `LifecycleSummary` :98, the declaration :156, step 6
  :273-290, and the return field :383.
- Update the step-list comment :39-41 and :57-59, and the "ORDER MATTERS: 6 runs BEFORE 7"
  note :61-62 (now vacuous).

**`src/db/costs.ts`**
- Remove the `deepinfra` entry from `MODEL_SKUS` (:125-130). Refresh the header comment
  :117-123 and the netting comment (the "one DeepInfra account" rationale now names
  Fireworks). **Do not touch** `upsertInfraCost`.

**`src/model/forcedTool.ts`**
- Remove `if (host.endsWith('deepinfra.com')) return 'deepinfra';` (:77) — a DeepInfra host
  now returns the raw hostname, i.e. reports loudly as unmapped.
- `DEFAULT_OPENAI_BASE_URL` :54 → `https://api.fireworks.ai/inference/v1`;
  `DEFAULT_OPENAI_MODEL` :55 → `accounts/fireworks/routers/glm-5p2-fast`.
- Refresh comments :16, :63-66, :253-256.

**`.env.example`** :11-16, :35 **and :36** — base URL *and* `INFERENCE_MODEL=zai-org/GLM-5.2`
move together. Changing the URL alone points Fireworks at DeepInfra's model spelling.

**`scripts/spine-eval/lib/env.mjs`** :126 **and :127** — same pairing
(`EVAL_MODEL ?? 'zai-org/GLM-5.2'`). Both lines, or every spine-eval run 404s.

**Tests to update**
- `src/db/costs.test.ts` — **six** `recordModelUsage('deepinfra', …)` sites, not the
  :377-433 range alone: **:377, :396, :410, :498, :508, :514**. Switch each to `'fireworks'`
  with the fast SKUs (`glm-5.2-fast-input` / `-output` / `-cached-input`).
  ⚠ **:498 is the one that breaks silently if missed.** It asserts
  `toContain('usage absent')`, but with `MODEL_SKUS.deepinfra` gone,
  [costs.ts:181](../../../src/db/costs.ts#L181) throws `no cost_rates SKUs are mapped for
  vendor 'deepinfra'` *before* the `usage absent` throw at :212 — verified by reading the
  control flow. :508 and :514 would still pass, but for the wrong reason.
  **Leave :205-234 untouched** (the rate book still holds the deepinfra rows by design).
  `:483` iterates `MODEL_SKUS` one-way, so a removed entry only removes checks.
- `src/model/forcedTool.test.ts` :297 — expected vendor becomes `'api.deepinfra.com'`.
- `src/jobs/lifecycle.test.ts` — delete the step-6 describe block :636-733, the `:451`
  off-cadence assertion, the header note :68-71, **and `hasBillingKey: () => false` in the
  `COST_STUBS` object at :77** (a stub for a deleted dep; spread properties are exempt from
  excess-property checks, so typecheck will not catch it).

**`docs/control-plane.md`** :46-47 — documents `deepinfraUsage` as a **stable cron JSON field
name** and pins the step order ("6 runs BEFORE 7"). Both become false; update alongside.

**Render cleanup (after deploy):** delete `DEEPINFRA_BILLING_API_KEY` from the lifecycle
cron, then **DEPLOY** — a cron env change does not reach scheduled runs on save, and
Trigger Run would mask it by using current env.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [x] `grep -ri deepinfra src/ scripts/` returns only intentional historical references
- [x] `costs.test.ts` "listCurrentRates returns the seeded book" still passes **unchanged** —
      proof history stayed priceable

**Automated evidence 2026-08-19:** typecheck ✅ · lint ✅ · build ✅ · `npm test` 1776 passed /
8 skipped / 0 failed (−25 vs Phase 1: the deleted collector suite + the step-6 block).
`costs.test.ts` "listCurrentRates returns the seeded book" passes **unchanged**, which is the
direct proof history stayed priceable. PR #154 opened.

Review caught, and fixed: `.env.example` header still named the DeepInfra model two lines above
the Fireworks value it now sets (a 404 trap for anyone who trusted it); `run-agent.mjs` billed
ALL input at the fresh rate after the rate bump, over-reporting eval spend up to ~4.7x when a
cache key is set (the cached counts were collected and unused); three comment blocks still
asserted a failover lane that no longer exists; and two eval harnesses still told the reader
"nothing alerts on it", which Phase 1 made false.

### Live verification (agent-executable)
- Prerequisites: Render MCP, `supabase-test` MCP. **Render deploys from the fork
  `Yu-C1/TradesDatabase`** — merging on origin deploys nothing.
- [x] A scheduled (not Trigger Run) cron log line has no `deepinfraUsage` field and `ok:true`.
- [x] `select vendor, period_start, amount_usd, source from infra_costs where vendor='deepinfra'`
      still returns July $43.13 and August, unchanged.
- [x] `/admin` still renders July and August with non-zero measured DeepInfra spend.

**Live evidence 2026-08-19 (PR #154 merged as `e552a05`; cron auto-deployed `bf6230c`,
live 07:37:39Z):**
- **Scheduled** tick 07:40:39Z has NO `deepinfraUsage` field and `ok:true`. The 07:35:40Z tick
  — pre-deploy — still has it, so this is a genuine before/after, not an off-cadence artifact.
- The collector's LAST run was 07:30:30Z: August closed at **$22.61** (estimate). That is the
  frozen final figure.
- `infra_costs` intact: July $43.13 `invoice`, August $22.61 `estimate`.
- **Netting proven still correct** — the thing the whole keep-the-rates decision protects:
  `cost_rollup_monthly` for 2026-08 shows deepinfra allocated $22.5934 + measured $0.0166 =
  **$22.61 exactly**, i.e. the invoice with measured spend cancelled out. July: $43.13
  allocated. Removing the TypeScript changed nothing about how history prices.

### Manual verification
- [ ] `/admin` reads sensibly with the agent-inference line going flat — confirms the known
      Fireworks-invoice gap is understood, not a surprise.

---
*Pause after this phase — Manual verification is non-empty.*

## Phase 5: Delete the `deepinfra-prod` registration (irreversible)

### What this phase does
Removes the provider and its credential from the gateway. **The stored key is write-only —
it cannot be read back.** Do this only once Phases 1-4 are green and the fleet has run a full
day on Fireworks.

### Changes required
On `trades-box-1`, handed to the user:
```
openshell provider list -g nemoclaw            # confirm deepinfra-prod present, id 07392b14-…
openshell provider delete deepinfra-prod       # confirm exact subcommand from --help first
openshell provider list -g nemoclaw            # confirm gone; fireworks-prod untouched
```
Leave `nvidia-prod`, `nebius-trial` and every `s*-telegram-bridge` alone.

**`Box_Setup_Stuff/nemoclaw-inference-medic.sh`** — the rollback commentary at **:100-105**
(line 106 begins the unrelated `PROBE_TIMEOUT` rationale — do not swallow it) now
describes a provider that no longer exists. Rewrite it to say single-provider with no
rollback.

⚠ **Do NOT "correct" the 402 wording at :245-247 — an earlier draft of this plan said to
change it to 412, and that was wrong.** Fireworks' own docs
(https://docs.fireworks.ai/guides/inference-error-codes, verified 2026-08-19) define
**402 = "Account is not on a paid plan or has exceeded usage limits"** and
**412 = "Account is suspended or there's an issue with account status … also occurs when
attempting to invoke a LoRA model that failed to load."** So the medic's existing "check the
balance/credits (402)" line is CORRECT. If anything, ADD 412 as a second shape — and note
that 412 is not necessarily a money problem, which matters because our route is a *router*.
Reinstall and re-verify the md5. `inferenceMedicScript.test.ts:234-242` still passes (it
bans `deepinfra` from medic *output*, which comments are not).

### Automated verification
- [ ] `npm test` — medic decision-table tests still 9/9
- [ ] Deployed medic md5 matches the new repo md5 (`sudo md5sum` of the `ExecStart` path)

### Live verification (agent-executable)
- Prerequisites: `ssh tradesbox`, `supabase-test` MCP.
- [ ] Two clean medic ticks after the delete, still "serving verified"
- [ ] One more **real tool call through a seat**
- [ ] No open incident in `ops_events`

### Manual verification
- [ ] Confirm out loud that the escape hatch is gone and the runbook is the plan.

---

## Follow-ups (recorded, not in scope)

- **No Fireworks invoice collector exists** — the agent-inference line on `/admin` reads $0
  from Phase 2 onward. `cost_rates` already carries Fireworks prices; only the bill is
  missing. Options: a collector mirroring the deleted one, or hand-entry via `upsertInfraCost`.
- **Backup provider lane** — deferred by user decision to the move into production.
- **No deployed-vs-repo md5 inventory for the box.** `bootstrap-box.sh` was found stale only
  because this work diffed it. An inventory check would have caught it months earlier.
  *(The `Calls-worker` / `Board_Worker` env question moved OUT of follow-ups — it is now a
  blocking entry gate on Phase 4.)*
