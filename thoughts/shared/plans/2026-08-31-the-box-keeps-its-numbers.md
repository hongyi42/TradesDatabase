---
date: 2026-08-31
task: Retain the CPU/RAM/occupancy numbers the boxes already measure, so seat capacity can be decided from evidence instead of estimated from constants
research: verified live in-session against trades-box-1 and nemomonitor, 2026-08-31
status: phases 2-3 built (uncommitted); phases 0, 1, 4, 5 open
supersedes: nothing
amends: thoughts/shared/plans/2026-08-26-seat-capacity-and-overflow-safety.md (Phase 3 thresholds; Phase 4 n8n note)
---

## Build status

| phase | state |
|---|---|
| 0 — gateway unit + `BOX_UNITS` | **open** — needs the launch-config capture and a maintenance window |
| 1 — sysstat on trades-box-1 | **open** — one command, not yet run |
| 2 — `host_metrics` + `POST /control/metrics` | **built** |
| 3 — cgroup + PSI collection in `box-report.sh` | **built** |
| 4 — analysis queries | open, needs ~2 weeks of data |
| 5 — thresholds in the n8n evaluator | open, needs Phase 4's distribution |

Built in this pass:

```
supabase/migrations/20260901140000_host_metrics.sql   table + RLS + monitoring.health `boxes`
src/db/hostMetrics.ts                                 typed layer
src/mcp/httpServer.ts                                 POST /control/metrics
src/mcp/httpServer.test.ts                            8 tests (29/29 in the file)
Box_Setup_Stuff/box-report.sh                         report_metrics() collector
```

Verified: migration applied to the local stack and the derived deltas checked against
hand-computed values for the normal, reboot-reset and first-tick cases; the collector run against
the real cgroups on trades-box-1, returning all six sandboxes with per-container CPU odometers and
PSI. `npm run typecheck` and `npm run lint` clean.

⚠ **The local Supabase stack is 7 migrations behind** `supabase/migrations/` and still carries three
tables that have been dropped, so `npm test` shows 82 pre-existing failures across the planner,
observations, job-notes and tenant-settings suites. Confirmed pre-existing by running the same files
in a clean worktree at HEAD — identical failures with none of this work applied. It needs
`npx supabase db reset`, which is destructive to a stack another session is using, so it was left
alone. `src/db/database.types.ts` therefore received the generator's `host_metrics` block only,
rather than a wholesale regeneration that would have deleted the types the newer code depends on.

## Overview

The ask was "monitor CPU and RAM on the boxes, so I know peak vs off-peak, the optimal number of
agents per box, and whether boxes burst at the same time."

Reading [2026-08-26-seat-capacity-and-overflow-safety.md](2026-08-26-seat-capacity-and-overflow-safety.md)
collapses all four questions into one. Its sizing model is:

```
simultaneous turns  =  seats × turns-per-seat-per-hour × turn-duration-seconds / 3600

RAM:  0.39 GB × seats  +  0.415 GB × simultaneous-turns  +  1.5 GB host   ≤  box RAM
CPU:  0.015 × seats    +  (13.3 + 1.44 × round-trips) core-sec per turn   ≤  40% × vCPUs
```

**Every constant in that formula is already measured. Exactly one term is unknown:
`turns-per-seat-per-hour` — how hard real people actually drive their agents.** That single number,
plus the turn duration it multiplies, decides the seat cap. Everything else the request asked for
(peak/off-peak, fleet averages, correlated bursts) is a projection of the same underlying quantity:
**occupancy over time**.

So this is not a monitoring project. It is one measurement, taken continuously, on the boxes that
carry real seats.

### The finding that makes it cheap

`box-report.sh` already runs every 5 minutes on every box and already reads the number:

```bash
mb="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)"
report box-memory ok availMb="$mb"
```

It is measured 288 times a day, POSTed off-box, and then **discarded**. `recordOpsEvent` folds
observations into incidents, so `ok` with no open incident writes no row at all
(`src/db/opsEvents.ts`). That is correct behaviour for an incident log and useless for capacity.

**Nothing is missing from collection. What is missing is somewhere to put it.**

## Verified live, 2026-08-31

Every number below was read off the boxes in-session, not carried from a document.

**trades-box-1** (`tradesbox`, 34.211.61.184) — Ubuntu 22.04.5, 4 vCPU, 15,788 MB, **no swap**:

| | value |
|---|---|
| MemAvailable | 12,185 MB |
| host `oom_kill` (`/proc/vmstat`) | 0 |
| agent units / running containers | **7 / 6** |
| host cgroup `cpu.stat usage_usec` | 1,132,088,163,943 (~1,132,088 core-sec over ~55 d) |
| **mean CPU** | **0.24 of 4 cores — 15% of the 40% baseline allowance** |
| disk | 310 G, 7% used |

Per-container memory, against the plan's measured **~390 MB idle** constant:

```
s2   625 MiB   ← ~235 MB above its siblings
s5   445
s6   415
s3   413        (the only container with limits: 3.854 GiB / 1.0 cpu)
s7   401
s8   401
     ─────
     2700 MiB across 6 sandboxes
```

**The 08-26 constants reproduce five days later on an unrelated day.** Its idle row recorded
2,339 MB of containers against 11,816 MB available; today it is 2,700 MB against 12,185 MB. They are
not a one-off measurement.

**nemomonitor** (44.209.158.46) — 1,906 MB, MemAvailable 908 MB, **no swap**, n8n container 825 MiB.
The tightest-margin box in the fleet, and the one that watches everything else.

## Phase 0 — Close the gateway blind spot

**Not capacity work.** Sequenced first because it is a live single point of failure, because
every later phase edits the same file, and because building capacity metrics on a box whose most
load-bearing process is unwatched is building on sand.

The 08-26 plan flagged the gateway as unsupervised. Verified, and it is worse than recorded:

```
openshell-gateway.service   LoadState = not-found      ← no unit exists at all
gateway PID 2171            PPID 1, up 55 days         ← orphaned to init
nemoclaw-boot.service       Type=oneshot Restart=no, active(exited)
```

⚠ **Correction to the 08-26 plan.** `nemoclaw-boot.service` does not launch the gateway. Its
`ExecStart` is `/home/ubuntu/.local/bin/nemoclaw s8 doctor || true` after a 25-second sleep — a
boot-time repair whose side effect revives the gateway. So the gateway **does** return after a
reboot; the gap is a **mid-life crash**, where that oneshot has long since run and exited.

**The blast radius is verified, not assumed.** Every sandbox is pointed at it by construction:

```
container env         OPENSHELL_ENDPOINT=https://host.openshell.internal:8080/
container /etc/hosts  host.openshell.internal → 172.18.0.1
gateway listening     172.18.0.1:8080  and  127.0.0.1:8080
```

It also backs the six `ssh-proxy` tunnels on 18789–18794. One process, seven seats.

**And it is invisible.** `BOX_UNITS` in `box-report.sh` lists doorman, badge-pull, nudge-runner,
the medics and the recycler — all eight confirmed `loaded`, so those are genuinely watched. The
gateway is not in the list. Through a gateway death: containers still running, agent units still
active, doorman active, disk/mem/docker fine. **The monitor stays fully green while every seat is
broken.** That is the alive-but-dead case `system-design` Tier 4 exists for.

⚠ **Order is load-bearing.** `unit_status()` returns `skip` for any unit whose `LoadState` is not
`loaded`, and `check_units` logs *"not installed — skipping"*. Adding `openshell-gateway.service`
to `BOX_UNITS` **today would silently monitor nothing** — a check that reads as configured and
covers zero. The unit must exist first.

1. **Capture the real launch config before authoring anything.** The binary's `--bind-address`
   default is `127.0.0.1`, yet the running process is also bound to `172.18.0.1:8080`. That
   configuration comes from somewhere — a TOML config (`--config` / `OPENSHELL_GATEWAY_CONFIG`) or
   `OPENSHELL_*` environment variables. Read `/proc/2171/environ` and the process's argv, and
   reproduce them exactly.

   ⚠ **This is the step that can cause the outage it prevents.** A unit with a bare `ExecStart`
   may bring the gateway back **loopback-only**, cutting off all seven sandboxes at once.

2. **`/etc/systemd/system/openshell-gateway.service`**, with the captured config:

   ```ini
   [Unit]
   Description=OpenShell gateway (sandbox control plane, serves every seat on this box)
   After=docker.service network-online.target
   Requires=docker.service

   [Service]
   User=ubuntu
   Environment=HOME=/home/ubuntu
   ExecStart=/home/ubuntu/.local/bin/openshell-gateway   # + captured flags/env
   Restart=always
   RestartSec=10
   OOMScoreAdjust=-500

   [Install]
   WantedBy=multi-user.target
   ```

   `OOMScoreAdjust=-500` is 08-26 Phase 1.3: under pressure the kernel should take one sandbox
   (revived in ~30 s by the existing loop), never the process every seat depends on. `dockerd` is
   already at −500; the gateway sits at 0.

3. **Then** add `openshell-gateway.service` to `BOX_UNITS`.

4. **Bake it into `bootstrap-box.sh`.** One gateway per host is structural — it binds `:8080`, so a
   second would collide — which means every new box inherits its own unsupervised SPOF. Fixing only
   trades-box-1 fixes one of N. This is 08-26's "fix the recipe, not the pilot."

**Verification**
- `systemctl show openshell-gateway.service -p Restart --value` → `always`.
- Kill it; confirm it returns within ~15 s **and** that a sandbox can still reach
  `host.openshell.internal:8080` afterwards.
- `cat /proc/<pid>/oom_score_adj` → `-500`.
- Force a down state and confirm `box-openshell-gateway` reaches Telegram — per 08-26's warning
  about `manager-push-is-dead`, an unproven alert path is not coverage.

## Phase 1 — sysstat on trades-box-1 (same day, zero code)

nemomonitor has been collecting host CPU/RAM history every 10 minutes for days. trades-box-1 — the
box with seven seats and the only one whose capacity is in question — collects nothing and retains
nothing. The metrics collector is on the box with no variable to observe.

```bash
sudo apt-get install -y sysstat
sudo sed -i 's/^HISTORY=.*/HISTORY=30/' /etc/sysstat/sysstat
sudo systemctl enable --now sysstat-collect.timer sysstat-summary.timer sysstat.service
```

⚠ **`ENABLED="false"` in `/etc/default/sysstat` is a red herring.** nemomonitor collects fine with it
set to false — on Ubuntu 22.04 that flag is legacy cron plumbing and the **systemd timers** drive
collection. The usual "set ENABLED=true" advice is a no-op here.

`HISTORY=30` rather than the packaged 7 is the one edit that matters: capacity is a monthly
question and a rolling week cannot answer "what did peak look like across a month". nemomonitor
uses 3.6 MB for ~5 days at 10-minute sampling, so 30 days at 5-minute is ≈40 MB against 291 GB free.

Optional, to align the series with `box-report.sh`:

```bash
sudo mkdir -p /etc/systemd/system/sysstat-collect.timer.d
printf '[Timer]\nOnCalendar=\nOnCalendar=*:00/05\n' \
  | sudo tee /etc/systemd/system/sysstat-collect.timer.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart sysstat-collect.timer
```

⚠ The bare `OnCalendar=` line is required — systemd **appends** to list-valued settings, so without
it both the 10-minute and 5-minute schedules fire. The drop-in also survives package upgrades, which
an edit to the shipped unit would not.

**What it gives:** `sar -r` memory, `sar -u` CPU, `sar -q` load, `sar -W` swapping, `sar -B` paging —
**whole-host only**. It answers *"was this box under pressure at 3pm Tuesday"* within a week of
install, with no schema, no collector, no code and no new secret.

**What it cannot ever give:** per-container or per-seat attribution. That boundary is why Phases 2–3
still exist.

**Verification** — `systemctl list-timers sysstat-collect.timer` shows a NEXT inside the interval;
`ls /var/log/sysstat/` has a `saDD` file; `sar -r` returns rows after two intervals. Once relied
upon, `sysstat-collect.timer` joins `BOX_UNITS` — unlike the gateway it **will** be `loaded` after
install, so that line works immediately.

## Phase 2 — Stop discarding what is already collected

A new append-only table, and a route that writes to it. No new agent, no new cron, no new secret.

1. **Migration** — `host_metrics`:

   ```sql
   create table host_metrics (
     host_id         uuid        not null references hosts(id) on delete cascade,
     observed_at     timestamptz not null,
     mem_avail_mb    int,
     mem_total_mb    int,
     disk_used_pct   int,
     seats           int,          -- from systemd, never sandbox_pool
     cpu_cores       int,
     load5           numeric,      -- context only, never a threshold
     oom_kills       bigint,       -- host /proc/vmstat, CUMULATIVE
     cpu_usage_usec  bigint,       -- host cgroup cpu.stat, CUMULATIVE
     psi_mem_some_us bigint,       -- /proc/pressure/memory, CUMULATIVE
     psi_mem_full_us bigint,
     psi_cpu_some_us bigint,       -- /proc/pressure/cpu
     sandboxes       jsonb not null default '{}'::jsonb,
     primary key (host_id, observed_at)
   );
   alter table host_metrics enable row level security;   -- no policies: deny by default
   ```

   **`load1` is deliberately absent.** Sampled every 5 minutes it describes a 1-minute window, so
   four minutes in five are never observed — a twitchier number with holes in it, answering nothing
   `load5` does not answer better. `load5` itself is stored as context only: Linux load counts
   uninterruptible-sleep tasks alongside runnable ones, so a disk-heavy backup and a real CPU
   shortage produce the same number.

   ⚠ **Store odometers, never deltas.** A cumulative counter that misses a sample self-heals — the
   next delta spans 10 minutes instead of 5 and is still arithmetically correct. A stored delta
   loses that interval permanently.

   RLS on with no policies, per `data-security` §1 and B1: the web service reaches it via
   `service_role` (which bypasses RLS) and n8n reaches it only through the `monitoring` view below.
   There is no `tenant_id` — this is infrastructure data, not tenant data — so the fail-closed
   posture is deny-all plus two explicit readers, not a tenant filter.

2. **`POST /control/metrics`** in `src/mcp/httpServer.ts`, modelled directly on `handleOpsReport`
   (`:434`): same `Bearer` + `sha256hex` + `getHostByTokenHash` gate, same bare 401, same 64 KiB
   `readRawBody` cap, same 5xx-and-move-on posture, routed **before** the IP allowlist for the same
   reason the ops path is.

   ⚠ **`host_id` comes from the token, never the body** — exactly as `handleOpsReport` does it, so
   one box cannot file metrics against another.

   It must be a **new** route, not a flag on `/control/ops`. That handler's whole contract is
   `recordOpsEvent` incident folding; a healthy reading through it is discarded by design, and
   mixing time-series writes into it would muddy the one path alerting depends on.

3. **`box-report.sh`** — one added POST at the end of the sweep, after the existing checks and
   before the Healthchecks ping. Same always-exit-0, hard-`--max-time`, keys-only discipline.

   ⚠ **Seat count comes from systemd, never from `sandbox_pool`.** The 08-26 plan calls that ledger
   partial; live it is wrong in **both** directions:

   ```
   in ledger, not running:  s1, s4
   running, not in ledger:  s2, s3, s7, s8
   both:                    s5, s6        ← the ledger and reality overlap on 2 of 8
   ```

   `check_agents()` already enumerates `nemoclaw-agent-*.service` from systemd at run time, for
   exactly this class of reason (`system-design` Tier 3). Reuse it. *(Separately: 7 units against 6
   containers — one unit has no container. Worth a look; likely already reported down.)*

4. **Retention** — dated debt, per `system-design` Tier 2. At 5-minute cadence, 3 boxes is ~26 k
   rows/30 days; the `sandboxes` jsonb dominates at ~1 KB/row, so 90 days ≈ 80 MB. **Add a prune
   before 2026-12-01** or when the table passes 250 k rows, whichever comes first.

**Verification** — unit tests beside `src/mcp/httpServer.test.ts`'s `/control/ops` block: unknown
token → 401; body-supplied `host_id` ignored in favour of the token's; oversized body → 413;
duplicate `(host_id, observed_at)` does not error the reporter. Then `npm run typecheck && npm run
lint && npm test` **against the local stack only**.

## Phase 3 — The measurement only the box can take

Confirmed readable on trades-box-1, cgroup v2 unified, no new tooling:

```
/sys/fs/cgroup/cpu.stat                          usage_usec 1132088163943
/sys/fs/cgroup/system.slice/docker-<id>.scope/   usage_usec 73412892231
                                                 memory.events oom_kill 0, max 0
                                                 memory.pressure some total=35839
/proc/vmstat                                     oom_kill 0
/proc/pressure/memory                            some total=2823709  full total=2338488
/proc/pressure/cpu                               some total=68840398503
```

`report_metrics()` in `box-report.sh` reads all of the above and POSTs one row. The collection runs
in `python3` — it is almost entirely `/proc` and `/sys` reads, where shell would need a dozen more
subprocesses and a dozen more ways to half-fail — with every read individually guarded so an
unreadable file omits ONE field rather than losing the tick. The docker calls stay in shell under
hard timeouts, because they are the only part that can hang.

### PSI — the metric that moves in the failure mode we actually observed

`/proc/pressure/*` counts **microseconds spent stalled waiting for a resource**, cumulatively. Not
how much is left; how long anything waited. `some` = at least one task was stalled; `full` = every
task was.

This matters because 08-26's stress test found the box **degrades by queueing, not by failing**. At
16 simultaneous turns — 2.7× the seat count — turns went from 16 s to 85 s while:

```
oom kills        0                       → an oom alarm stays silent
MemAvailable     4,563 MB of 15,788 = 29% → a "< 15%" alarm stays silent
load5            marginal at best         → may not fire either
```

**Every quantity-based alarm is silent through that, and every user waits 5× longer.** Pressure is
the only thing that changes, because stalling is what queueing *is*.

Two properties earn it a column rather than a dashboard:

- **Cumulative**, so a 5-minute sample cannot miss a stall — the same property that makes
  `usage_usec` trustworthy as a turn counter.
- **Unambiguous**, unlike `load5`: it separates `cpu`, `memory` and `io`, so the metric name already
  says which resource is short.

⚠ **It is a contention metric, not an activity metric, and the two must not be confused.** PSI rises
only when a resource is *scarce*; a sandbox can be flat out busy at PSI zero. Peak/off-peak comes
from `usage_usec`, never from PSI. Read live, trades-box-1 shows **2.8 seconds of memory stall
across 55 days** — that flat zero is itself the finding: seven seats have never once run short.

`memory.events` `max` is collected alongside `oom_kill` for the same reason: `max` counts times a
container hit its limit and had to reclaim — the warning — while `oom_kill` is the tombstone.

**Occupancy then has two independent estimators, and they calibrate each other:**

```
memory-derived     (container_mem_total − 390 MB × seats) / 415 MB
                   direct, assumes no rate — but INSTANTANEOUS, so a 16–45 s turn
                   is caught by a 5-minute sample only ~5–15% of the time

cpu-delta-derived  Δ usage_usec / 300 s  =  mean cores busy
                   INTEGRATING — cannot miss a turn — but needs cores-per-turn,
                   which 08-26 has from only two points (0.91 simple, 0.51 tool-heavy)
```

Running both turns their disagreement into the answer: **cores-per-turn solved from production
traffic**, replacing a 1.8× uncertainty band with a measured constant. Neither alone does this.

⚠ **This is where 08-26's discarded methodology differs.** Its first draft derived *per-seat cost*
from cumulative counters on trades-box-1 and rightly threw it out: that box is test infrastructure
where most sandboxes are never driven, so the average measured an idle machine. That objection
holds for **cost per seat** and does not hold for **counting activity** — a counter that increments
only when work happens is not distorted by idle seats, it just reads low. The distinction must
survive into implementation: these counters measure *when and how much*, never *what a seat costs*.

## Phase 4 — Analysis (monthly SQL, not a dashboard)

After two weeks of Phase 2 data and one week of Phase 3:

- **Peak vs off-peak** — mean and p95 occupancy by hour-of-day and day-of-week.
- **Correlated bursts** — cross-box correlation of occupancy in the same 5-minute bucket. This is
  the "multiple boxes bursting at once" question, and it needs the centralised table; per-box `sar`
  files cannot answer it.
- **`turns-per-seat-per-hour`** — the one unknown term, from Δ`usage_usec` ÷ measured cores-per-turn.
- **Optimal agents per box** — feed both back into the 08-26 sizing formula.

That last output is the deliverable. Its consumer is 08-26's own rule: *"when the 95th percentile
stays under ~8 for 30 days on a full box, raise `max_seats` toward 60."*

## Phase 5 — Alerting, last

Thresholds go into the `Evaluate probes` Code node in `deploy/n8n/workflows/external-probes.json`,
alongside the existing eleven — **never into SQL**. Retuning a view means pilot DDL applied by hand,
which nobody does, and an unretuned monitor gets muted.

Capacity columns extend the existing `monitoring.health` view rather than adding a second view and a
second query node: `external-probes` makes one DB call, and a second doubles the credential surface
for no gain. `monitor_ro` keeps SELECT on that view and nothing else.

The view already does the differencing, so the evaluator reads ready-made rates. Each box appears in
`boxes` keyed by host name, with `age_s`, `mem_avail_pct`, `cpu_busy_cores`, `oom_kills_delta` and
`psi_*_pct` alongside the raw values.

```
psi_mem_some_pct  sustained above ~10%                    ← the leading indicator;
                                                            replaces load5, does not add to it
oom_kills_delta   > 0                                      the tombstone (host counter)
memory.events max increased                                the warning before it
mem_avail_pct     < 15%                                    the blunt backstop
age_s             > ~900                                   the box stopped reporting
seats             ≥ max_seats − 8                          ← blocked, see below
BurstCapacity     < 25%                                    (Lightsail, only if ever wired)
```

⚠ **`psi_*_pct` and `oom_kills_delta` are NULL when there is no preceding tick to difference
against** — a box's first-ever reading, or a gap wider than the view's 2-hour window. NULL means
"cannot say". Numeric comparison reads NULL as 0, which would turn missing data into a silent pass,
so the evaluator must test for null explicitly. `age_s` is what actually catches a silent box.

⚠ **Two of 08-26's Phase 3 thresholds cannot fire as written.**

**`oom_kill` is structurally dead.** Its threshold is "any container's `memory.events` `oom_kill` is
non-zero". That counter records kills against **the cgroup's own limit**, and live:

```
s8 s7 s6 s5 s2   mem=0            nanocpus=0     ← unlimited
s3               mem=4138729472   nanocpus=1e9   ← the only capped container
```

Five of six containers have no limit, so their counter can never increment. The alarm would read as
coverage while monitoring nothing — precisely `system-design` Tier 4's "a green signal must never
hide a dead subsystem". **Watch host `/proc/vmstat oom_kill` as well**; it is the only one that can
fire before 08-26 Phase 1.1 lands `docker update --memory`.

**`max_seats` does not exist.** `hosts` carries only `name`, `token_hash`, `created_at`. That column
is 08-26 Phase 2, so this threshold waits on it — or lives as a constant in the workflow until then.

**Sequenced last on purpose.** A threshold picked before the distribution is known is a guess, and a
noisy monitor gets muted. 08-26 said the same thing and it was right.

**Verification** — extend `deploy/n8n/test-evaluate.mjs`, which reads the Code node out of the
workflow JSON rather than a copy. One case per threshold, one boundary case proving `>` not `>=`,
and a NULL case: empty sets return NULL, numeric comparison reads NULL as 0, and quiet periods would
otherwise pass silently.

## Corrections to the 2026-08-26 plan

| | |
|---|---|
| `nemoclaw-boot.service` launches the gateway | It runs `nemoclaw s8 doctor`; the revival is a side effect. The gap is a mid-life crash, not a reboot. |
| Phase 3: alert on container `memory.events oom_kill` | Cannot fire on 5 of 6 containers (no limits). Add the host `/proc/vmstat` counter. |
| Phase 3: alert on `seats ≥ max_seats − 8` | `hosts.max_seats` does not exist yet — blocked on its own Phase 2. |
| `sandbox_pool` is partial (1 instead of 6) | Wrong in both directions; overlaps reality on 2 of 8. |
| Phase 4: "consider evicting n8n from trades-box-1" | Already done, 2026-08-27. n8n runs on nemomonitor. |
| Phase 1 verification: re-run the ladder on the 8 vCPU box | Still correct, and **should run alongside Phase 1 here, not after** — it yields production constants directly and needs none of this collection work. |

## Explicitly NOT doing

- **A dashboard.** Capacity is a monthly question answered with a query. The 08-26 rule is
  `max_seats` moves on 30 days of evidence — a live chart adds nothing to a decision made twelve
  times a year.
- **AWS/Lightsail metrics via API.** Lightsail publishes `CPUUtilization`, `BurstCapacity*`,
  `NetworkIn/Out`, `StatusCheckFailed` — and **no memory metric**, because the hypervisor cannot see
  inside the guest. It measures the axis that is not binding (mean CPU is at 15% of baseline) and
  cannot measure the one that is. Polling it would also put an AWS credential on the monitor box,
  which is the one component deliberately kept holding almost nothing. **Read the console when the
  trend is wanted; wire the API only if that proves worth automating.**
- **A third collector.** `box-report.sh` and `sysstat` already cover collection. Writing a
  `free -m >> file` cron would reinvent sysstat without rotation, compression, or a query tool.
- **Parallelising `nudge-runner.sh`.** 08-26 is explicit and it bears repeating here, because
  capacity work is exactly when someone reaches for it: its serial `while read` loop accidentally
  rate-limits the one pattern that could produce a correlated cross-box burst. **That serialisation
  is load-bearing.**
- **Per-turn instrumentation inside the agent.** The cgroup counters answer the question from
  outside, with no change to the hot path.

## Sequencing

1. **Phase 1** (sysstat) — same day. Independent of everything, starts banking data immediately,
   and the only step whose value grows with how early it happens.
2. **Phase 0** (gateway) — in a scheduled window. A live SPOF today at any load. Its `BOX_UNITS`
   edit and Phase 3's collector additions touch the same file, so they can ship as one rollout.
3. **Phase 2** — the table and the route, as a normal PR.
4. **Phase 3** — the cgroup counters, once Phase 2 has somewhere to put them.
5. **Two weeks pass.** No conclusions before then.
6. **Phase 4**, then **Phase 5**.

**Nothing here is urgent on the measurements.** Host `oom_kill` is 0, mean CPU is 15% of the
baseline allowance, and 08-26's ladder took 16 simultaneous turns — 2.7× the seat count — with
4.5 GB to spare. The two exceptions are the unsupervised gateway, which is a risk today at any load,
and nemomonitor's 908 MB of headroom with no swap.

## Open items surfaced, not addressed here

- **nemomonitor memory trend.** `sar` shows daily averages rising 28.6% → 30.9% over 27–29 Aug. The
  obvious cause is ruled out — `EXECUTIONS_DATA_PRUNE=true`, `MAX_AGE=336`, `database.sqlite` 2.2 MB,
  `/home/node/.n8n` 22.6 MB — so it is not n8n execution data. Four daily averages is too thin to
  call a leak, and this session's own SSH activity confounds today's readings. **Re-check in a week;
  sysstat will still hold the data.**
- **No swap on either box.** 08-26 Phase 1.4 wants 4 GB. It matters more on nemomonitor (908 MB
  available of 1,906) than on trades-box-1.
- **Sandbox gateway tokens appear in the host process table** as `openshell ssh-proxy` argv. Reading
  them requires a shell on the host, which is already game over, so severity is low — but `hidepid`
  would close it.
- **Rotate the box-alive Healthchecks ping URL** for trades-box-1. Ping URLs are write capabilities;
  this one was surfaced in a session transcript.
