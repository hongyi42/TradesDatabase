---
date: 2026-08-26
task: Define the production box recipe and capacity-aware seat provisioning, from measured constants rather than pilot history
research: stress-tested in-session on trades-box-1 (1 Hz cgroup sampling under a driven concurrency ladder)
status: proposed
supersedes: nothing
---

## Overview

**Methodology note, and why an earlier draft of this plan was wrong.** The first version derived
per-seat cost from *cumulative CPU counters* on trades-box-1 — two to five weeks of history per
container. That box is internal test infrastructure where most sandboxes are never driven, so those
averages measured an idle machine and said nothing about a real user's seat. They are discarded.

Everything below comes from one of two sources only:

1. **Constants** — costs that do not depend on how anyone uses the product (what a container costs
   to merely exist; what one turn costs; what the hardware provides).
2. **A driven stress test** — a concurrency ladder (1 → 4 → 8 → 16 simultaneous turns) and a
   session-growth run, executed on the box and sampled at 1 Hz from cgroup counters.

Usage rates are **not** assumed anywhere. Where a number depends on how much customers talk to the
agent, this plan says so and leaves it as an input.

## The measured constants

**Per sandbox, idle** (a container doing nothing but its 30 s healthcheck and Telegram long-poll):

| | value |
|---|---|
| Memory (anon, unreclaimable) | **~390 MB** |
| CPU | **~1.5% of one core** |

**Per concurrent turn**, on top of idle:

| | value |
|---|---|
| Memory | **~415 MB** for the turn's duration, fully released after |
| CPU | **~14 core-seconds** (steady state); ~24 for the first turn in a cold session |

**Session growth does not change CPU cost.** Eight turns in one session, grown to 73,893 bytes:

```
turn 1   28.1s wall   23.6 core-sec    ← cold-session first turn
turn 2   16.0s wall   12.4 core-sec
turn 4   16.6s wall   13.9 core-sec
turn 6   16.4s wall   12.6 core-sec
turn 8   22.9s wall   17.2 core-sec    ← session now 74 KB
```

Wall time drifts up (16 s → 23 s) but **CPU stays flat at 12–17 core-seconds**. The added latency is
server-side prefill of a larger context, not work on our box. Growing conversations cost the
*inference provider* more and cost the box almost nothing.

**What 74 KB means in tokens** (read from the `usage` records the sessions already store):
`input + cacheRead` per turn is the real context size. Measured ≈ **4.3 bytes of session file per
token of conversation**, on top of a **fixed ~30,500-token baseline** (system prompt + AGENTS.md +
tool schemas) that every turn carries regardless of length. So the 74 KB test session ended at
**~48,000 tokens of context per turn**.

**How large real sessions grow is UNKNOWN, and this plan does not guess.** trades-box-1 is a testing
environment — its session files are the owner's own test chats and eval runs, so nothing about their
size or rotation predicts a real firm. Any number read off that box is inadmissible here.

**Instead it is already bounded: auto-compact is ON by default.** Read from the installed openclaw
bundle (`dist/sessions-BFCD5uPV.js`) and from the box's own `openclaw.json`:

| setting | value | source |
|---|---|---|
| `compaction.enabled` | **`?? true`** — on unless explicitly disabled | `getCompactionEnabled()` :3552 |
| `compaction.reserveTokens` | **16,384** | `getCompactionReserveTokens()` :3561 |
| `compaction.keepRecentTokens` | **20,000** | `getCompactionKeepRecentTokens()` :3564 |
| `contextWindow` | **131,072** | the sandbox's `openclaw.json` |

So context is already capped: compaction triggers as the transcript approaches
**131,072 − 16,384 ≈ 115,000 tokens**, and reduces it to a summary plus the most recent **20,000
tokens**. Steady state therefore oscillates between roughly **55K and 115K tokens** (the ~30,500
fixed baseline + 20K recent + summary, growing back to the trigger). **No change is required to bound
session growth — it is bounded.** (Trigger arithmetic is inferred from the bundle, not from vendor
docs; the three defaults and the configured window are verbatim.)

**Recommendation — leave `enabled` alone; the tunable worth considering is `contextWindow`.** It is
set to 131,072 while Fireworks actually serves 1,040,000, i.e. we are already running 8× more
conservative than the model allows. That is the right direction for cost. Lowering it further to
~98,000 would cut average context roughly 25% with no behavioural change.

⚠ **There is a hard floor.** `contextWindow` must stay comfortably above
`baseline + keepRecentTokens + reserveTokens` ≈ 30,500 + 20,000 + 16,384 ≈ **67,000 tokens**, or
compaction fires continuously (or cannot free enough) and the agent thrashes. **Never set
`contextWindow` below ~80,000** with the current AGENTS.md and tool surface — and note that the
baseline term grows whenever tools or doctrine are added, so this floor moves.

⚠ **Do not apply it with `openclaw config patch`** — per [[openclaw-config-patch-breaks-gateway]]
every config write drops permissions and the restore fail-closes silently. Bake it into
`bootstrap-box.sh` (the `bakein` phase) so new boxes inherit it, exactly as the other config edits
are handled.

**Why it matters — cost, not box capacity.** Fireworks GLM-5.2: $1.40/M input, **$0.14/M cached
input**, $4.40/M output, 1,040K-token window. **A cache miss costs 10× a hit**, and misses are
visible in the usage records (fresh `input` spikes while `cacheRead` falls back to the baseline). So
cache hit rate is the real lever — and note the **~30,500-token fixed baseline is larger than a
typical conversation**, so trimming tool schemas and AGENTS.md would cut inference spend more than
session management would. Recorded so it is not missed.

**The concurrency ladder** (6 sandboxes, 1 Hz sampling, container cgroups only):

| Simultaneous turns | Wall time each | CPU total (of 400%) | Container memory | MemAvailable | OOM / pressure |
|---|---|---|---|---|---|
| idle | — | 9% | 2,339 MB | 11,816 MB | 0 / 0 |
| 1 | ~16 s | 89% | 3,562 MB | 10,474 MB | 0 / 0 |
| 4 | 29 s | 235% | 4,003 MB | 9,850 MB | 0 / 0 |
| 8 | 45 s | 280% | 5,681 MB | 8,003 MB | 0 / 0 |
| 16 | 85 s | 316% | 8,597 MB | 4,563 MB | **0 / 0** |

**At 16 simultaneous turns — 2.7× the box's entire seat count — nothing failed.** No OOM kill, no
cgroup memory-pressure event, 4.5 GB still available. The box degrades by queueing: turns get
proportionally slower and throughput plateaus at ~0.17 turns/second. That is the honest answer to
"what happens on overflow" — **it gets slow, and it stays up.**

## Tool-heavy turns: more CPU, but no sustained burst

The ladder above used one simple prompt. A fair worry is that a long agentic task — many Composio
round trips into Gmail, Excel, etc. — sustains a CPU burst far beyond it. **Measured on a badged
sandbox, it does not.**

| | simple turn | heavy multi-tool turn | ratio |
|---|---|---|---|
| Inference round trips | 3 | 10 | 3.3× |
| Tool calls | 2 | 13 | 6.5× |
| Output tokens | 271 | 5,537 | 20× |
| Context processed (input + cacheRead) | 115,207 | 466,885 | 4.1× |
| Wall time | 19.3 s | 54.8 s | 2.8× |
| **CPU** | **17.6 core-sec** | **27.7 core-sec** | **1.57×** |

Fitting the two points gives **CPU ≈ 13.3 + 1.44 × round-trips core-seconds** — a large fixed cost
per turn and a small marginal cost per extra tool round trip. Six and a half times the tool calls
bought only 57% more CPU.

**CPU *intensity* actually falls as a turn gets more tool-heavy** — 0.91 cores → 0.51 cores — because
tool calls are network waits (sandbox → doorman → Render → Composio; the relay leg alone is ~2.3 s
per call, see [[composio-relay-latency]]). Waiting costs no CPU.

**The real hazard is concurrency, not CPU.** Concurrency = arrival rate × turn duration, and a turn
holds its ~415 MB for its whole duration. A task that runs 5 minutes instead of 20 seconds multiplies
concurrent slots **15×** at the same arrival rate. At 60 seats, four 5-minute Composio tasks per user
per hour = 20 simultaneous turns = **8.3 GB on top of 23 GB of idle floor — over a 32 GB box's
budget.** Long-running tool tasks are the one usage pattern that can break the sizing model, and they
break it through *memory occupancy*, not CPU.

**Consequences for this plan:** the Phase 3 watchdog should alert on **sustained simultaneous turn
count**, not just memory and load — it is the leading indicator. And if long-running Composio tasks
become common, revisit the "no admission control" decision, since that is precisely the regime where
capping simultaneous turns starts to earn its complexity.

⚠ **Separately, found while tracing the tool path:** `doorman.mjs` buffers each request body
**entirely in memory with no size cap** (`chunks.push(c)` → `Buffer.concat`) in the single Node
process that serves every sandbox on the box. Responses are streamed via `pipeline` (correct), and
request size is bounded in practice by the model's output limit — but the Render-side control routes
cap their bodies at 64 KiB for exactly this reason and the doorman does not. Worth a cap; not
urgent.

## Box sizing (production runs on fresh boxes)

Capacity is two terms — an unavoidable floor per seat, plus headroom for whoever is mid-turn *right
now*. Since a turn holds its memory for its whole duration, the second term is driven by
**occupancy**, not by a turns-per-hour rate:

```
simultaneous turns  =  seats × turns-per-seat-per-hour × turn-duration-seconds / 3600

RAM:  0.39 GB × seats  +  0.415 GB × simultaneous-turns  +  1.5 GB host   ≤  box RAM
CPU:  0.015 × seats    +  (13.3 + 1.44 × round-trips) core-sec per turn   ≤  40% × vCPUs
```

That duration term is why usage *mode* matters more than usage *volume*:

| mode | turns/seat/hr | duration | simultaneous @ 60 seats |
|---|---|---|---|
| Chat-style (what we measured) | 2 | 20 s | **0.7** |
| Occasional agentic task | 2 | 5 min | **10** |
| Routine agentic tasks | 4 | 5 min | **20** |

**Sizing each plan** (host reserve 1.5 GB; remainder split between idle floor and turn headroom):

| Lightsail plan | seats | idle floor | headroom left | simultaneous turns it buys | $/seat |
|---|---|---|---|---|---|
| $84 — 4 vCPU / 16 GB | 25 | 9.8 GB | 4.7 GB | 11 | $3.36 |
| **$164 — 8 vCPU / 32 GB** | **40** | **15.6 GB** | **14.9 GB** | **36** | **$4.10** |
| $164 — 8 vCPU / 32 GB | 60 | 23.4 GB | 7.1 GB | 17 | $2.73 |
| $384 — 16 vCPU / 64 GB | 100 | 39.0 GB | 23.5 GB | 56 | $3.84 |

**Recommendation: the $164 plan (8 vCPU / 32 GB), capped initially at 40 seats.**

- **Why $164:** the 1.5 GB host reserve and the turn-headroom block amortise badly on a 16 GB box —
  after reserving either, the $84 plan has very little left for seats. 64 GB concentrates 100+ seats
  in one failure domain for worse $/seat than 60-on-$164.
- **Why 40 and not 60:** 60 seats is correct *if* usage is chat-style, and tight the moment long
  agentic tasks become routine (20 simultaneous turns vs 17 of headroom). We do not know which mode
  real firms will land in, and guessing is exactly what this plan refuses to do. 40 seats absorbs
  even the routine-agentic case with 36 turns of headroom.
- **Raise the cap on evidence, not on hope.** The Phase 3 watchdog reports simultaneous-turn
  occupancy; when its 95th percentile stays under ~8 for 30 days on a full box, raise `max_seats`
  toward 60. `max_seats` is a per-host column precisely so this is one UPDATE, not a redeploy.

CPU is not the binding term at either cap. At 40 seats the idle tax is 0.6 of the 3.2 sustained
cores, leaving room for ~520 chat-style or ~230 agentic turns per hour — far above any plausible
demand from 40 tradespeople.

**The idle floor dominates: seat count, not traffic, is what fills a box.** 40 seats = 15.6 GB spent
before anyone says a word. That is convenient — seat count is the one variable we control exactly,
and the one the seat cap enforces structurally.

## The scale decision point (target unknown)

This plan is built for **25–100 seats**, whose early steps are also correct for the smaller path.
The divergence, recorded so it is not missed:

- **Below ~40 seats:** one $164 box. Phase 2's placement logic is *nice to have*; the seat cap alone
  is sufficient.
- **40–500 seats:** multi-box. Phase 2 becomes load-bearing, and box provisioning needs to be
  repeatable rather than a runbook someone follows by hand.
- **Above ~500 seats:** re-open the architecture, do not scale this plan. At 390 MB idle per seat,
  500 seats is 195 GB of RAM to keep containers alive that are mostly asleep — roughly $2,000/month
  to run idle processes. That is the point where one-container-per-person should be challenged, not
  guardrailed. **Do not treat that as a far-future concern**: it arrives at ~8 boxes.

## Decisions

- **Fix the recipe, not the pilot.** Production runs on fresh boxes, so every safety property must
  come from `bootstrap-box.sh` producing a correct box from scratch. Repairing trades-box-1 in place
  is a separate, lower-priority phase — it is test infrastructure.

- **No turn admission control.** Turns start inside each container from a Telegram long-poll; there
  is no shared admission point, and the doorman sees only *tool calls*, so blocking there breaks
  turns mid-flight. The stress test removes the motivation anyway: 16 simultaneous turns produced
  slowness, not failure. A seat cap is one integer and achieves more.

- **Per-container limits are for containment, not capacity.** A `--memory` cap stops one runaway
  seat from taking the box. It does **not** stop sixty well-behaved seats from adding up past the
  box's RAM. Aggregate is controlled by the seat cap. Both are needed; they solve different problems.

- **`--memory` is safety-critical, `--cpus` is secondary.** The kernel's scheduler already shares CPU
  fairly — proven by the ladder, where per-turn cost stayed ~14 core-seconds from 1 to 16 concurrent.
  Memory has no such fairness. Evidence the limits are cheap: **s3 has run for two weeks at
  `--cpus 1.0` / 4.14 GB and cost ~3.5% turn latency** in a head-to-head against an uncapped
  sandbox.

- **Bin-pack, don't spread.** A box costs the same whether it holds 1 seat or 60. Blast radius is
  handled by the seat cap and per-container limits, not by paying for empty boxes.

- **Reuse `ops-report.sh` → `POST /control/ops` for alerts.** Already exists, authed by the host pull
  token, stateless, always exits 0. ⚠ Depends on `OPS_ALERT_CHAT_ID` and `BOARD_BOT_TOKEN` being
  set; per [[manager-push-is-dead]] an unset token made pushes fail silently for 30 days. **Prove an
  alert arrives before trusting any of this.**

## Plain-language walkthrough

```
       A PRODUCTION BOX, BUILT RIGHT              WHAT THE PILOT BOX HAS TODAY
  ┌────────────────────────────────────┐     ┌────────────────────────────────────┐
  │ 32 GB / 8 vCPU, capacity 60 seats  │     │ 16 GB / 4 vCPU, no posted capacity │
  │ every sandbox has a memory ceiling │     │ 5 of 6 sandboxes unlimited         │
  │ the shared gateway is supervised   │     │ gateway orphaned, no supervisor    │
  │ 4 GB swap as a cushion             │     │ no swap at all                     │
  │ warns the operator at 48 seats     │     │ nothing watches capacity           │
  └────────────────────────────────────┘     └────────────────────────────────────┘
```

Each seat is a passenger who is always aboard, even asleep — that is the 390 MB. A passenger who is
*talking* needs another 415 MB, but only while talking, and gives it straight back. The van has room
for sixty sleepers plus fifteen talkers at once. If more than fifteen talk simultaneously, nobody is
thrown out — everyone just talks slower.

## Phase 1 — The production box recipe

Everything a fresh box needs so it is safe on its first day. All changes in `Box_Setup_Stuff/`.

1. **Resource limits at provision time** — in `bootstrap-box.sh` `phase_provision()` (~line 221),
   after `nemoclaw onboard --non-interactive`:
   ```bash
   docker update --memory 3g --memory-swap 4g --cpus 2 "$cid"
   ```
   `3g` sits well above the highest per-container anon measured under load (~1.7 GB during the
   session-growth run). `--memory-swap 4g` grants 1 GB of swap allowance so a container under
   pressure slows before it dies. `--cpus 2` bounds a runaway without clipping a normal turn.

2. **Supervise the gateway.** `openshell-gateway` serves every sandbox on the box, but it is launched
   by `nemoclaw-boot.service`, which is `Type=oneshot` / `Restart=no` and has been `active (exited)`
   since 2026-07-07 — the process is orphaned to PID 1. **If it dies, nothing restarts it.** Add a
   real `openshell-gateway.service` (`Restart=always`, `RestartSec=10`, `User=ubuntu`);
   `nemoclaw-boot.service` keeps the sandbox-revival half and gains
   `After=openshell-gateway.service`.

3. **OOM protection for shared processes.** Set `OOMScoreAdjust=-500` on `openshell-gateway.service`
   and `doorman.service`. Today both sit at 0 while `dockerd` is protected at −500. Under memory
   pressure the kernel should take a sandbox — recoverable in ~30 s via the `nemoclaw-agent-revive.sh`
   supervision loop — never a shared process that would take every seat down at once.

4. **Swap.** 4 GB swapfile + `vm.swappiness=10`, in `fstab` and `sysctl.d` so it survives reboot.

5. **Box spec.** Update the runbook: production boxes are the **$164 / 8 vCPU / 32 GB** plan. Note
   its baseline is still 40% (`docs.aws.amazon.com/lightsail/latest/userguide/baseline-cpu-performance.html`).

**Verification** (on a fresh box, before any real seat lands on it)
- `docker inspect` shows non-zero `Memory` and `NanoCpus` for every sandbox.
- `systemctl show openshell-gateway.service -p Restart` → `always`; kill it and confirm it returns
  within ~15 s.
- `cat /proc/<pid>/oom_score_adj` → `-500` for gateway and doorman.
- `free -m` shows swap; still present after a reboot.
- Reboot: gateway + all sandboxes return hands-off (the migration runbook's Gate C).
- **Re-run the concurrency ladder on the new box** (4 / 8 / 16 turns) and confirm the constants hold
  at 8 vCPU. This is the number that justifies the 60-seat cap — do not take it on faith from a
  4 vCPU box.

## Phase 2 — Capacity-aware seat provisioning

**Problem.** `listFreeSandboxes(tenantId)` (`src/db/sandboxPool.ts:63`) filters by tenant, orders
FIFO by `created_at`, and has no idea which host a blank is on or whether it has room. `hosts` stores
only `name`, `token_hash`, `created_at`.

1. **Migration** — `hosts` gains `max_seats int not null default 40` and
   `accepting_seats boolean not null default true` (drain a box for maintenance without deleting it).
2. **`src/db/hosts.ts`** — `listHostsWithLoad()`: each host with claimed-seat count, `max_seats`, and
   derived headroom.
3. **`src/db/sandboxPool.ts`** — `listFreeSandboxes` excludes blanks on hosts that are full or
   draining; orders least-headroom-first (bin-pack), then `created_at` for determinism.
   `claimSandbox`'s claim-if-still-free race protection is unchanged and still correct.
4. **Fail loud.** When every free blank sits on a full host, distinguish *"no seats left in your
   plan"* from *"we are out of capacity — the operator has been alerted"*, and fire a
   `POST /control/ops`. Today both collapse into "ask your operator", which tells the operator
   nothing.

⚠ **Trap — step 0 of this phase.** `sandbox_pool` is a *partial* ledger: it holds rows for s1, s4,
s5, s6 only. **s2, s3, s7 and s8 have no row at all.** A seat count read from it returns 1 instead of
6 and would cheerfully overfill a box. Backfill the missing rows first — that also stops the ledger
lying to everything else that reads it.

**Verification** — unit tests in `src/db/sandboxPool.test.ts` (blank on a full host not returned;
draining host excluded; bin-pack order deterministic; concurrent claims still cannot collide), then
`npm run typecheck && npm run lint && npm test` against the **local** stack only.

## Phase 3 — Capacity watchdog

New `capacity-watch.sh` + `.service`/`.timer` (every 5 min), modelled exactly on `ops-report.sh`:
reads `HOST_PULL_TOKEN`/`PULL_URL` from `/etc/doorman/badge-pull.env`, hard `--max-time`, **always
exits 0**, keeps no state. Reports "needs attention" when any of:

- MemAvailable < 15% of total (on a 32 GB box, < 4.8 GB),
- seats on this box ≥ `max_seats − 8` (32 of 40) — the "order the next box" trigger,
- **sustained simultaneous-turn count** above ~60% of the box's turn headroom — the leading
  indicator, and the one that moves first when long agentic tasks appear,
- any container's `memory.events` `oom_kill` is non-zero,
- 5-minute load average > 1.5 × vCPU count.

**Verification** — force each threshold and confirm a Telegram alert actually arrives at
`OPS_ALERT_CHAT_ID`. **Prove the path end to end before trusting it**; a watchdog nobody hears is
worse than none because it looks like coverage.

## Phase 4 — Repair trades-box-1 (lower priority: it is test infrastructure)

Apply Phase 1's properties to the existing box, where they are cheap and safe:

- A re-runnable `apply-limits.sh` reconciler for the five unlimited containers. `docker update`
  writes `HostConfig`, so limits survive container restarts; they are lost on *recreation*, hence
  idempotent and re-runnable.
- The gateway supervisor + OOM adjustments (Phase 1.2/1.3) — **this one is worth doing regardless of
  priority**, because an unsupervised shared process is a live single point of failure today,
  independent of load.
- Swap.
- Consider evicting `n8n` (462 MB + a 2.26 GB image, unrelated to the seat fleet — 1.2 seats of RAM).
  **Confirm with the owner first**; it may be load-bearing for something outside this repo.

## Explicitly NOT doing

- **Turn admission control / concurrency limiter.** See Decisions. Revisit only if measured peak
  concurrency exceeds ~15 on a 32 GB box.
- **Parallelising `nudge-runner.sh`.** It delivers through a serial `while read` loop, which
  accidentally rate-limits the one pattern that could produce a correlated burst across many
  sandboxes at once. **That serialisation is load-bearing — it looks like an easy optimisation and
  it is not.**
- **Spreading seats across boxes for isolation.** See Decisions.
- **Stopping cold blanks to reclaim their 390 MB.** Tempting, but it lands on the known-fragile
  restart path ("agents do NOT survive container restarts in new-generation NemoClaw"). Worth an
  experiment on a blank seat someday; not part of a safety plan.

## Sequencing

1. **Phase 1** — the production box recipe. Nothing else matters until a fresh box comes up safe.
2. **Phase 4's gateway fix** on trades-box-1, in a scheduled window (it briefly interrupts every
   seat). Do this early despite the phase number: it is a live single point of failure.
3. **Phase 2** as a normal PR, with the `sandbox_pool` backfill as step 0.
4. **Phase 3** last, once there is a capacity number worth alerting on.

**Nothing here is urgent on the measurements.** `oom_kill` is 0 across every container's lifetime,
and 16 simultaneous turns — 2.7× the box's seat count — degraded gracefully with 4.5 GB to spare.
The one exception is the unsupervised gateway, which is a risk today at any load.
