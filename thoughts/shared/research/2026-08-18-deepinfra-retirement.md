---
date: 2026-08-18
branch: docs/agent-first-front-door
commit: 6d49e3b
topic: Retiring DeepInfra as the fleet's inference provider — box route + medic, Render services, and the repo code/doc surface
---

## Summary

"Inference provider" means the company whose computers actually run the AI model that
answers a technician's Telegram message. Today two separate systems each pick that company
independently, and **right now they disagree**: the six agent sandboxes on the box
(`trades-box-1`) are routed to **DeepInfra**, while the Render services (the "spine" — the
web server, the cron heartbeat, the workers) are pointed at **Fireworks**. That split is
not a bug; it is a deliberately parked state from 2026-08-15, when Fireworks suspended the
account over a monthly spend cap and the box was rolled back to DeepInfra while Render was
left on Fireworks.

Retiring DeepInfra means making the box agree with Render. Mechanically that is small: two
lines in one shell script on the box. What makes it a real piece of work is everything
attached to those two lines — a timer that fights any manual change, a provisioning script
on the box that is stale and would re-assert the old provider, a monthly bill collector
that is DeepInfra-specific and has no Fireworks equivalent, and an alerting path that
records outages faithfully into a database table that **nothing reads**. That last one is
the load-bearing finding for the recovery procedure this task owes: the fleet already
suffers regular provider outages (11 recorded incidents in the last 6 days, averaging 57
minutes, worst 8.6 hours), every one of them self-healed, and **not one of them notified a
human**.

---

## Verification status of the briefing's claims

Every stated fact was independently re-checked. All confirmed, plus four the briefing
did not mention.

| Claim | Verdict | Evidence |
|---|---|---|
| Box fleet routed to DeepInfra | ✅ CONFIRMED | `openshell inference get -g nemoclaw` → `deepinfra-prod` / `zai-org/GLM-5.2`, version 9221 |
| `fireworks-prod` already registered | ✅ CONFIRMED | type `openai`, cred key `OPENAI_API_KEY`, config key `OPENAI_BASE_URL`, id `c0167cac-…` |
| Also present: nvidia-prod, nebius-trial, 6× `s*-telegram-bridge` | ✅ CONFIRMED | `openshell provider list -g nemoclaw` — 10 providers total |
| Medic pins the route every 5 min | ✅ CONFIRMED | timer `active`+`enabled`, last run 04:55:48Z, next 05:00:48Z |
| Deployed medic md5 `43cba3c9…` | ✅ CONFIRMED | `sudo md5sum /usr/local/sbin/nemoclaw-inference-medic.sh` |
| Repo medic md5 `0921ab1e…` | ✅ CONFIRMED | `md5 -q Box_Setup_Stuff/nemoclaw-inference-medic.sh` |
| **Exactly two lines differ** | ✅ CONFIRMED | full `diff` → only lines 98–99 |
| Render spine on Fireworks and serving | ✅ CONFIRMED | pilot `cost_events`: last spine model call `2026-08-18 23:18:29Z` stamped `fireworks`/`glm-5.2-fast-*`; last `deepinfra` spine call was `2026-08-14 00:40:56Z` |
| **Render is 5 services, not 2** | ⚠️ NEW | web + lifecycle cron + Calls-purge cron + Calls-worker + Board_Worker |
| **Deployed `bootstrap-box.sh` is STALE** | ⚠️ NEW | box md5 `33fea955…` ≠ repo `973afe2f…`; box copy still sets `deepinfra-prod` |
| **`DEEPINFRA_BILLING_API_KEY` is set on the cron** | ⚠️ NEW | inferred decisively — see Data Flows |
| **`ops_events` has no reader — no alert reaches a human** | ⚠️ NEW | `grep` finds one writer, zero readers |

Note on dates: the box clock read `2026-08-19 04:57 UTC` during this research while local
was still 2026-08-18 PDT. This is the documented midnight-straddle window.

---

## Entry Points

The provider decision is made in exactly **three** independent places. Nothing shares
configuration between them.

```
       ┌──────────────────────── WHO PICKS THE PROVIDER ────────────────────────┐
       │                                                                        │
  (1) THE BOX — agent turns              (2) RENDER — spine model calls         │
      6 Telegram sandboxes                   classify · extract · brief ·       │
      s2 s3 s5 s6 s7 s8                      answer · teamLeadCompose           │
            │                                        │                          │
            ▼                                        ▼                          │
   openshell gateway route              env vars INFERENCE_BASE_URL /           │
   set by WANT_PROVIDER/WANT_MODEL       INFERENCE_API_KEY / INFERENCE_MODEL    │
   in the medic, re-asserted /5min       read at call time by forcedTool.ts     │
            │                                        │                          │
            ▼                                        ▼                          │
   ►► deepinfra-prod ◄◄  (TODAY)         ►► fireworks.ai ◄◄  (TODAY)            │
                                                                                │
  (3) EVAL HARNESSES — EVAL_* vars, separate again; never touch production      │
       └────────────────────────────────────────────────────────────────────────┘
```

**(1) The box** — [Box_Setup_Stuff/nemoclaw-inference-medic.sh:98-99](../../../Box_Setup_Stuff/nemoclaw-inference-medic.sh#L98-L99)

```bash
WANT_PROVIDER="fireworks-prod"                                    # repo
WANT_MODEL="accounts/fireworks/routers/glm-5p2-fast"
# ── deployed copy at /usr/local/sbin/ says instead: ──
WANT_PROVIDER="deepinfra-prod"  # TEMP 2026-08-15: parked on rollback while Fireworks suspended…
WANT_MODEL="zai-org/GLM-5.2"
```

**(2) Render** — [src/model/forcedTool.ts:239-241](../../../src/model/forcedTool.ts#L239-L241) reads
`INFERENCE_API_KEY` / `INFERENCE_BASE_URL` / `INFERENCE_MODEL` at every call. Default base
URL is DeepInfra ([forcedTool.ts:54](../../../src/model/forcedTool.ts#L54)).

**(3) Evals** — `EVAL_INFERENCE_*`, resolved in
[scripts/spine-eval/lib/env.mjs:125-130](../../../scripts/spine-eval/lib/env.mjs#L125-L130) and
[scripts/date-eval/plan.mjs:143](../../../scripts/date-eval/plan.mjs#L143).

---

## Key Files

### The box (highest risk)

| Path | Role | DeepInfra content |
|---|---|---|
| [Box_Setup_Stuff/nemoclaw-inference-medic.sh](../../../Box_Setup_Stuff/nemoclaw-inference-medic.sh) | Asserts the route every 5 min; two-gate health probe | `WANT_*` (repo: Fireworks); header history + rollback commentary at lines 10-27, 100-106 |
| `/usr/local/sbin/nemoclaw-inference-medic.sh` | **The one that actually runs.** md5 `43cba3c9…` | `WANT_*` = DeepInfra, TEMP-commented |
| [Box_Setup_Stuff/nemoclaw-inference-medic.service](../../../Box_Setup_Stuff/nemoclaw-inference-medic.service) | Unit; `OnSuccess=`/`OnFailure=` → ops-report | Description already says "Fireworks" |
| [Box_Setup_Stuff/bootstrap-box.sh:285-288](../../../Box_Setup_Stuff/bootstrap-box.sh#L285-L288) | Re-asserts the route after onboard/recycle | repo = Fireworks; **deployed = DeepInfra** |
| `/usr/local/sbin/bootstrap-box.sh` | **STALE** md5 `33fea955…` | lines 176, 284-286 set `deepinfra-prod` |
| [Box_Setup_Stuff/ops-report.sh](../../../Box_Setup_Stuff/ops-report.sh) | Carries the medic verdict to Render | Provider-agnostic (line 78 parses whatever route is set) — **no change needed** |

### Repo code

| Path | Role | Impact |
|---|---|---|
| [src/model/deepinfraUsage.ts](../../../src/model/deepinfraUsage.ts) | Pulls the monthly DeepInfra bill into `infra_costs` | Entire file is DeepInfra-specific. `billingApiKey()` at :98-107 is the decision point |
| [src/jobs/lifecycle.ts:273-290](../../../src/jobs/lifecycle.ts#L273-L290) | Cron step 6, summary field `deepinfraUsage` | Runs on quarter-hour ticks; currently succeeding |
| [src/db/costs.ts:124-158](../../../src/db/costs.ts#L124-L158) | `MODEL_SKUS` — ledger vendor → priced SKUs | `deepinfra`, `nvidia`, `fireworks`, `anthropic` all mapped. Fireworks already correct |
| [src/model/forcedTool.ts:69-81](../../../src/model/forcedTool.ts#L69-L81) | `ledgerVendor()` — host → billing vendor | Already handles `fireworks.ai`. **No change needed** |
| [src/control/inferenceMedicScript.test.ts](../../../src/control/inferenceMedicScript.test.ts) | Pins the medic's decision table | **Already written for the post-flip world** — asserts `fireworks-prod` primary (:195, :197, :230) and bans `deepinfra` from medic output (:241) |
| [src/admin/adminApi.ts:135](../../../src/admin/adminApi.ts#L135), [web/admin/admin.js:71](../../../web/admin/admin.js#L71) | Cost dashboard | Provider-agnostic code; DeepInfra only in comments |

### Scripts and docs

`scripts/provider-trial/*` (3 files, DeepInfra as benchmark baseline),
`scripts/date-eval/run.mjs` + `plan.mjs` + `README.md`, `scripts/spine-eval/lib/env.mjs`
(DeepInfra default base URL), `scripts/eval-date-reliability.mjs`.

Doc mention counts (`deepinfra` / `fireworks`):
`docs/engineering-memory.md` 43/12 · `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` 6/10 ·
`Box_Setup_Stuff/doorman-architecture-memory.md` 4/7 · `docs/control-plane.md` 3/0 ·
`docs/onboarding.md` 3/0 · `HANDOFF.md` 3/0 · `.env.example` 3/0 ·
`docs/long-running-task-batching.md` 2/0 · `docs/nemoclaw-tech-agent.md` 1/0.

---

## Data Flows

### A. An agent turn (the thing that breaks if the route is wrong)

```
technician's Telegram message
        │
        ▼
  OpenClaw sandbox (openshell-s5-…)   ── 6 containers, all "Up … (healthy)"
        │
        │  https://inference.local/v1/chat/completions
        │  gateway injects the credential; NO provider key is ever in the container
        ▼
  openshell gateway ── route: provider + model, GATEWAY-WIDE (not per seat)
        │
        ▼
  DeepInfra  ←── TODAY.  Flipping this one setting moves ALL SIX seats at once.
```

**There is no per-seat route.** `openshell inference set --help` offers only
`-g/--gateway`; `nemoclaw inference set --sandbox <name>` sounds per-seat but its own help
says it updates *"the OpenShell inference route and sync[s] the running … sandbox config"* —
the route is still gateway-level. **A staged, one-seat-first rollout is not available.**

The one safety property that *is* available: `openshell inference set` **live-verifies the
endpoint and key before saving** (there is a `--no-verify` flag to opt out). So a suspended
Fireworks key makes the `set` *fail* and leaves the current route untouched. That is the
cheapest possible test of the box's never-yet-exercised Fireworks credential.

### B. The medic tick, every 5 minutes

```
timer ──► medic ──► (1) openshell inference set  [registration gate: endpoint+key live-verified]
                     │
                     └► (2) docker exec -u sandbox sh -lc curl https://inference.local/v1
                            production-shaped probe: 3 real tool schemas, system prompt,
                            streaming ON, 512 max_tokens, 40s timeout
                            PASS requires BOTH  `data: [DONE]`  AND  finish_reason:"tool_calls"
                            one retry on a miss
                     │
        ┌────────────┴────────────┐
     both pass                 either fails
        │                         │
   exit 0 "serving verified"   route HELD on primary, exit 1 LOUD
        │                         │
   OnSuccess=                  OnFailure=
   ops-report ok               ops-report down
        │                         │
        └──────────┬──────────────┘
                   ▼
        POST /control/ops on Render  (host badge token)
                   ▼
        recordOpsEvent() → ops_events table
                   ▼
              ✗ NOTHING READS IT ✗
```

The last hop is the finding. `recordOpsEvent` folds repeats into one incident, and its own
docstring says suppression exists so *"any notifier built on top"* does not fire six times.
**That notifier was never built.** `grep -rn "ops_events"` across `src/` returns one writer
([httpServer.ts:480](../../../src/mcp/httpServer.ts#L480)), the generated types, and nothing
else. Detection works; delivery to a human does not exist.

### C. Where the money record comes from — and the trap inside it

[`billingApiKey()`](../../../src/model/deepinfraUsage.ts#L98-L107) resolves in two ways:

```
DEEPINFRA_BILLING_API_KEY set?  ──yes──►  use it
        │no
        ▼
INFERENCE_BASE_URL host ends in deepinfra.com  AND  MODEL_PROVIDER != 'anthropic'?
        │yes──► use INFERENCE_API_KEY
        │no ──► return undefined  ⇒  cron reports {skipped: 'no DeepInfra billing key configured'}
```

Two observed facts pin the answer:

1. The cron made a **Fireworks** model call at `2026-08-18 23:18:29Z` (pilot `cost_events`),
   so its `INFERENCE_BASE_URL` is `api.fireworks.ai` — the fallback branch **cannot** fire.
2. The same cron's `deepinfraUsage` step **succeeded** at `2026-08-19 04:45:41Z`, writing
   2026.07 = `$43.13` (invoice) and 2026.08 = `$22.59` (estimate).

Both can only be true if **`DEEPINFRA_BILLING_API_KEY` is explicitly set on the lifecycle
cron**. Consequence: the bill collector is *already decoupled* from the route. Flipping the
box changes nothing about it. It keeps working until that key is removed or revoked.

### D. What the cost dashboard will show after the flip

`infra_costs` today holds `deepinfra`/`agent inference` rows for 2026-07 and 2026-08 — and
**no `fireworks` row at all**. Nothing collects a Fireworks invoice; `deepinfraUsage.ts` is
the only bill collector and it is vendor-specific.

The rollup nets measured spend against the bill **keyed on the same vendor**
(`where e.provider = v_bill.vendor`,
[20260725130000_cost_rollup_fn.sql:150-158](../../../supabase/migrations/20260725130000_cost_rollup_fn.sql)),
so the accounting stays *correct* — but with no Fireworks bill, the largest cost line
renders **$0** from the moment box traffic moves. That is precisely the failure
`deepinfraUsage.ts`'s own header calls out: *"a cost ledger whose biggest number defaults to
zero is worse than no ledger."*

Rates are not the gap — `cost_rates` already carries Fireworks
(`glm-5.2-fast-input` $2.10/M, `-output` $6.60/M, `-cached-input` $0.21/M, effective
2026-08-15). Only the *invoice* is missing.

### E. The provisioning path that will break

```
sandbox recycle / new seat
        │
        ▼
/usr/local/sbin/recycle-sandbox.sh   ($RECYCLER_BOOTSTRAP, line 40)
        │
        ▼
/usr/local/sbin/bootstrap-box.sh  ← STALE (md5 33fea955…, repo is 973afe2f…)
        │
        ├─ onboard resets the gateway to the NVIDIA free tier
        └─ line 285: `openshell inference set … --provider deepinfra-prod --model zai-org/GLM-5.2`
                     ▲
                     └── after retirement this targets a provider that may no longer exist
```

Today this is masked: the medic overwrites it within 5 minutes. After the flip the stale
line becomes actively wrong, and if the `deepinfra-prod` registration is deleted it fails
outright (the script's own `|| echo "! route flip failed"` catches it non-fatally, leaving
the seat on the rate-limited NVIDIA default for up to 5 minutes).

---

## External Dependencies

- **Fireworks AI** — `api.fireworks.ai/inference/v1`, model
  `accounts/fireworks/routers/glm-5p2-fast`. Two *separate* credentials: Render env
  (`INFERENCE_API_KEY`, proven serving) and the box's `fireworks-prod` provider credential
  (`OPENAI_API_KEY`, **not exercised since the 2026-08-15 suspension**). Failure shape:
  **HTTP 412 `PRECONDITION_FAILED`** on account suspension from the monthly spend cap.
- **DeepInfra** — `api.deepinfra.com/v1/openai` (inference) and `api.deepinfra.com/payment/usage`
  (billing; note the different path root). Failure shape: **HTTP 402** on balance-out.
  Amounts are in **cents** ([deepinfraUsage.ts:40](../../../src/model/deepinfraUsage.ts#L40)).
- **Nebius** (`nebius-trial`, registered, type `openai`) and **NVIDIA** (`nvidia-prod`,
  known to 400 on real turns). Neither is in the route path.
- **Render** — 5 services in workspace `tea-d69903h5pdvs738dm81g`, all deploying from the
  fork `Yu-C1/TradesDatabase`:

  | Service | ID | Type | Auto-deploy | Makes model calls? |
  |---|---|---|---|---|
  | TradesDatabase | `srv-d8uqmdegvqtc73bfn83g` | web | **no** | yes (classify/extract/brief/answer) |
  | lifecycle-heart | `crn-d93iq7a8qa3s73ap6260` | cron `*/5` | yes | yes (`teamLeadCompose`) |
  | Calls-worker | `srv-d9qelh710e5c739hb8vg` | worker | yes | yes (`classifyCall`) |
  | Board_Worker | `srv-d9dr8iurnols73d1tjq0` | worker | **no** | not established |
  | Calls-purge | `crn-d9qeov1t0dsc73funmag` | cron `0 4 * * *` | yes | no |

---

## Constraints and Invariants

1. **The medic wins any manual change within 5 minutes.** `openshell inference set` by hand
   is reverted before you finish reading its output. Change the deployed script, or stop
   the timer, *first*.
2. **The route is gateway-wide.** No per-seat staging exists. All six seats move together.
3. **`openshell inference set` verifies before saving** (unless `--no-verify`). A bad
   credential fails the command and leaves the route intact — this is the natural
   pre-flight test and the reason the flip is one reversible command.
4. **Repo-merged ≠ box-deployed.** There is no CI to `trades-box-1`. Verify by
   `sudo md5sum` of the path `ExecStart` names — the files are mode 700 root, so a plain
   `md5sum` fails in a way that looks like "not installed". Two files are currently out of
   sync with the repo: the medic (deliberate) and `bootstrap-box.sh` (**not** deliberate,
   and previously unrecorded).
5. **`ops_events` is write-only.** Nothing reads it; no notifier exists.
6. **Failure codes are not portable.** Fireworks 412 (spend cap) ≠ DeepInfra 402 (balance).
   The medic's own warning text still names "402" and "the Fireworks account balance"
   ([medic:245-247](../../../Box_Setup_Stuff/nemoclaw-inference-medic.sh#L245-L247)) — a
   mismatch already present in the repo copy.
7. **The medic probe assumes the model emits tool calls.** Its header says so explicitly:
   *"this is an assumption about the MODEL, not the provider"*. Same GLM-5.2 weights on
   both providers, so the flip does not disturb it.
8. **The no-fallback design is enforced by a test.**
   [inferenceMedicScript.test.ts:234-242](../../../src/control/inferenceMedicScript.test.ts#L234-L242)
   asserts medic output never contains `nvidia` or `deepinfra`. Re-introducing a fallback
   requires deliberately editing that test.
9. **A Render cron env change needs a DEPLOY.** Saving does not deploy; Trigger Run uses
   current env, so manual tests pass while scheduled runs stay stale.
10. **Local `main` is stale.** Local `main` = `c7b8dc4`; `origin/main` = `9ca98e3`
    ("eng-memory: record the DeepInfra retirement decision"). A worktree at
    `.claude/worktrees/route-deeplink` holds the `main` checkout. Working tree also has an
    uncommitted 43-line `docs/engineering-memory.md` edit (nudge pacing — unrelated).

### The measured outage baseline

`ops_events`, service `inference-medic`, since 2026-08-13 (6 days):

| | |
|---|---|
| Incidents | **11** |
| Still open | 0 — every one self-healed |
| Average duration | **57 min** |
| Worst | **517 min** (8.6 h, 2026-08-14 17:44Z → 2026-08-15 02:21Z, on DeepInfra) |
| The Fireworks suspension | **69 min** (2026-08-15 22:28Z → 23:37Z) — longer than the ~35 min in engineering-memory |
| Most recent | 2026-08-19 03:08Z → 03:18Z (10 min), on the current DeepInfra route |

Eight of the eleven were 4-minute blips. Two observations matter for the recovery
procedure: **provider outages are routine on either vendor**, and **the rollback that
"saved" the 08-15 suspension still cost 69 minutes of recorded downtime** — the escape
hatch was slower in practice than the memory records.

---

## Decision Points

### 1. How deep does removal go?

Four levels, each strictly larger than the last.

| Level | Action | Effort | What it costs to undo |
|---|---|---|---|
| **A. Repoint only** | Install the repo medic (2 lines). `deepinfra-prod` stays registered | ~1 command | Edit 2 lines back — **~1 min** |
| **B. + stale bootstrap** | Also install the current `bootstrap-box.sh` | +1 install | same as A |
| **C. + delete registration** | `deepinfra-prod` provider + credential removed from the gateway | +1 command | Re-register with a **new key** — the stored credential is not readable back |
| **D. + remove code** | Delete `deepinfraUsage.ts`, cron step 6, `MODEL_SKUS.deepinfra`, `ledgerVendor` branch, eval baselines | PR + test changes | Revert the PR; **historical rows keep a vendor the code no longer maps** |

Facts bearing on the choice, no recommendation:

- **B is not optional in the way A/C/D are.** The deployed bootstrap is stale *today*; that
  is a pre-existing defect this work surfaced, and it points at `deepinfra-prod` on a
  provisioning path that runs on every recycle.
- **C is what makes recovery expensive.** With the registration kept, "roll back" is a
  two-line edit. With it deleted, recovery needs a *valid DeepInfra key* — and the account
  has an unmetered balance that "runs out roughly monthly with nothing alerting on it"
  (engineering-memory). A retained-but-unused registration will silently rot.
- **D touches the money record.** `MODEL_SKUS.deepinfra` and the `deepinfra` branch of
  `ledgerVendor()` are what let historical `cost_events` rows still price correctly; the
  rollup INNER-joins `cost_rates`, so an unmapped vendor drops **silently**. Removing the
  price-book rows would make July/August history un-priceable.
- `deepinfraUsage.ts`'s cron step is currently **succeeding** and is independent of the
  route (see Data Flows C).

### 2. Historical cost data — does the bill pull stop?

Three options, given `DEEPINFRA_BILLING_API_KEY` is set explicitly on the cron:

| Option | Behaviour | Consequence |
|---|---|---|
| **Leave it running** | Keeps polling DeepInfra monthly; August closes with a real settled invoice, then reports `$0.00` months forever | History complete and self-closing; a permanently-$0 line stays on the dashboard |
| **Unset `DEEPINFRA_BILLING_API_KEY`** | Step reports `{skipped: 'no DeepInfra billing key configured'}` — a designed, non-error state | Clean; **but if unset before the final August invoice settles, the last month freezes as an `estimate` ($22.59) and never becomes `invoice`** |
| **Remove the step (level D)** | No collection at all | Same freeze risk, plus a code change |

Existing rows are **not** at risk in any option: `infra_costs` is keyed on
`(vendor, item, period_start)` and nothing deletes. The exposure is only the *final*
month's estimate→invoice transition.

### 3. The uncollected Fireworks bill

Independent of 1 and 2, and not named in the briefing. Once box traffic moves to Fireworks,
the agent-inference line on `/admin` reads **$0** — no `infra_costs` row for `fireworks`
exists and no collector produces one. Options: build a Fireworks collector (mirrors
`deepinfraUsage.ts`, different API), hand-enter monthly via the existing `upsertInfraCost`
path, or accept a $0 line. This is the exact silent-underreport failure the collector was
written to prevent.

### 4. What "recovery" can even mean — and the alerting gap

The task requires a tested recovery procedure. What exists today constrains it:

- **Detection works.** The medic uses a real tool call (its own doctrine) and catches a
  dead provider inside ~5 minutes. Verified live: 11 incidents correctly opened and closed.
- **Notification does not exist.** `ops_events` has no reader. Every one of those 11
  incidents was invisible unless someone was already looking. A recovery procedure whose
  first step is "notice" has no mechanism behind it.
- **There is no fast lane back.** Post-retirement the candidates are: re-register DeepInfra
  (needs a key of unknown validity), `nebius-trial` (registered, benched 59/59, **never
  production-verified, and standing one up is explicitly out of scope**), `nvidia-prod`
  (known to 400 every real turn), or `MODEL_PROVIDER=anthropic` — which is **Render-only**
  and does nothing for the box.
- **The 412 vs 402 split is live in the code.** The medic's failure text names 402 and
  "balance"; Fireworks suspends with 412 on a spend cap. An operator following the current
  wording checks the wrong thing.

The fork: whether recovery is defined as *restore service on another provider* (which
needs a lane, out of scope) or *shorten the outage* (raise the Fireworks cap / clear the
suspension — a billing action, and the only lever that actually applied on 08-15).

### 5. Which Render services need touching

The briefing says web + cron. Five services exist; three make model calls (web,
lifecycle-heart, Calls-worker), each with its own Environment tab. Whether all three
already carry the Fireworks vars is **not established** — only that *something* running the
`teamLeadCompose` step (the cron) is on Fireworks. Two services have **auto-deploy OFF**
(web, Board_Worker), so a merge does not redeploy them.

---

## Open Questions

1. **Is the box's `fireworks-prod` credential still valid?** Unexercised since the 2026-08-15
   suspension. Not answerable by reading — but cheaply testable, because
   `openshell inference set` verifies before saving and leaves the route untouched on failure.
2. **Is the Fireworks monthly spend cap raised?** The 08-15 suspension came from the cap,
   not the balance. Only visible at `fireworks.ai/account/billing`. If unchanged, the flip
   re-creates the exact conditions of the outage — box traffic is far heavier than spine
   traffic.
3. **Do Calls-worker and Board_Worker carry the Fireworks env vars?** The MCP surface has no
   env-var *read* tool; needs a dashboard check. A worker still on DeepInfra keys would
   start failing the moment the key is revoked.
4. **Has August's DeepInfra invoice settled?** It reads `estimate` ($22.59). Determines
   whether unsetting the billing key freezes the final month.
5. **Is `nebius-trial`'s credential live?** Registered with a config key, benched 59/59 —
   never production-verified. Relevant only as context for what recovery options exist.
6. **What else on the box is stale?** `bootstrap-box.sh` was found stale only because this
   research diffed it. No inventory of deployed-vs-repo md5s exists.
7. **Was the deployed `bootstrap-box.sh` ever intentionally left behind,** or is it drift?
   A `.prev-20260718` backup sits beside it; the repo copy postdates the Fireworks switch.
