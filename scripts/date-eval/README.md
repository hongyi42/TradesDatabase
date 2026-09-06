# Date-machinery eval

Measures how well the agent handles dates in ordinary scheduling questions
("how many jobs do we still have this week?") — and, when it gets one wrong,
**which of the four phases broke**.

Run it when you change the date machinery, or when you want to compare models.

```bash
npm run date-eval:plan                              # free. builds the corpus + truth, prints the brief
npm run date-eval:run -- --dir <dir> --yes          # SPENDS MONEY. ~35 min, ~$1
npm run date-eval:report -- --dir <dir>             # free. re-runnable
```

`plan` prints the exact `run` command with the directory filled in. **`run`
does nothing without `--yes`** — that is the confirmation gate, and it is there
because a full pass is ~83 live model calls against the pilot.

## The four phases

A date passes through four hands. Each fails differently and needs a different
fix, so the report attributes every failure to exactly one of them.

```
  human phrase                                                    human reads
  "this Friday"                                                   "Friday Aug 14"
       │                                                                ▲
       ▼                                                                │
  ┌──────────┐      ┌──────────┐      ┌──────────┐            ┌──────────┐
  │ RESOLVE  │─────▶│   USE    │─────▶│  SPEAK   │───────────▶│  GUARD   │
  └──────────┘      └──────────┘      └──────────┘            └──────────┘
   call            carry the date     state it back           catch a bad
   resolve_date,   into the query     with its weekday        weekday↔date
   don't do the    window intact                              pair on the
   math in-head                                               way out
```

| Phase | Passes when | Typical failure |
|---|---|---|
| **Resolve** | the right calendar date came back from `resolve_date` | asked for `weeksAhead: 1` on "this Friday"; or never called the tool and did the math in-model |
| **Use** | that date reached the data tools unchanged and the window is right | queried Sun–Sat instead of Mon–Sun; a date literal in the SQL that no resolve produced |
| **Speak** | the reply names the right date, with its weekday, and the two agree | "Thursday August 14" when the 14th is a Friday; naming a date nothing produced |
| **Guard** | a contradiction that reached the text would be flagged | the outbound hook misses a fabricated pair |

**Resolve splits two ways, and the split is the point.** If the tool was called
with the right arguments and still returned the wrong date, that is the
*machinery* — your new code. If the arguments themselves were wrong, that is
the *model*. The analyzer recomputes every call independently (`expectedResolve`
in `corpus.mjs`) to tell them apart. That is the number to watch after a
machinery change.

Attribution is **earliest-failing-phase**. A date resolved wrongly makes the
query and the sentence wrong too; counting all three would report "speak is
broken" when speak faithfully repeated what it was handed. Downstream phases
are marked `inherited` and dropped from their own denominators.

## What each piece does

| File | Runs where | Role |
|---|---|---|
| `corpus.mjs` | — | the questions, the phase tags, and an **independent** implementation of the date math |
| `plan.mjs` | local | pulls schedule facts from the pilot DB (SELECT only), builds the corpus, writes `manifest.json`, prints the brief |
| `run.mjs` | local, drives the box over ssh | one agent turn per question in a throwaway session; pulls each trajectory back |
| `analyze.mjs` | local | phase attribution, guard replay, latency split, `report.md` |

Truth is **derived at plan time from the live DB**, not pinned in the file — so
when the test schedule is shifted forward the corpus moves with it instead of
quietly grading against a schedule that no longer exists.

The date math in `corpus.mjs` is a deliberate second implementation. It must
never import `src/schedule/dateResolve.ts`: that is the code under test, and a
shared helper would make the resolve check agree with the machinery exactly
when the machinery is wrong.

## Safety rails

- **Confirmation gate** — `run` exits without `--yes` after printing the cost.
- **Model check** — refuses to start unless the fleet is on the expected model
  (default `google/gemini-3.8-flash` since the 2026-09-05 evening flip — `meta/muse-spark-1.3` was the primary that morning, and is now the fallback. Run the eval on the direct single-model route with the medic timer stopped — never under the fleet's everyday `@preset/trades-seats` route, where a fallback to Gemini is invisible to this gate. Override with `DATE_EVAL_EXPECT_MODEL`).
- **Failover abort** — the inference route is re-read after *every* question.
  If it moves, the run **stops immediately** and says so. Results already
  collected stay valid (they were all on one model); nothing after would be.
  Resume with the same command once the route is fixed — answered questions
  are skipped. A provider balance-out is a when-not-if; since 2026-08-19 the ops
  notifier DOES alert on it (Telegram, via the inference medic) — see
  docs/inference-recovery-runbook.md.
- **Stale manifest** — refuses to run a manifest planned for a different day.
- **Read-only** — every question is phrased as a question, and any write tool
  appearing in a trajectory is reported as a finding.
- **Fresh session per question** — `dateval-<date>-<id>`, never the live chat.

## Observing phase 4 for real — `--deliver`

By default the run sends no reply, so no outbound hook fires and the report
**replays** the plugin's own `scanMessage` over each answer. That measures the
detector's *logic* exactly, but it is our code calling our function: it can
never tell you the hook is wired up.

```bash
npm run date-eval:run -- --dir <run-dir> --yes --deliver
```

fires the REAL `message_sending` hook inside the sandbox and records its verdict
per question (`guardLive`), which the report then prefers — and it flags any
REPLAY vs LIVE disagreement, since that means the deployed plugin differs from
this repo's copy or the hook is seeing different text than we graded.

It delivers to a **dead Telegram target (chat id 1)** on purpose. The hook runs
*before* the send, so the guard scans the real reply and logs a real verdict,
and the send then fails with `chat not found` — nobody is messaged. This matters:
the default sandbox is `s2`, which is the operator's own Telegram, so a
94-question corpus delivering for real would fire 94 messages at a person. Pass
`--reply-to <chatId>` only if you genuinely want them sent somewhere; the run
banner shouts when the target is live.

A question that delivers but produces **no** hook record is scored
`not-observed`, never as a pass — an unfired hook is a wiring symptom, not a
clean bill of health.

## One thing this harness cannot see
**AGENTS.md may be truncated on this path.** The embedded agent has been
   observed truncating the file at 12,000 characters, and the dates doctrine
   sits at ~20,400. If the runner sees a truncation notice it flags the report:
   those numbers describe a weaker prompt than production Telegram. Judge
   doctrine-dependent behaviour (rule 3's "ask, never pick" especially) from
   Telegram, not from here.

## Known coverage gap: month, quarter, year

`resolve_date` can express **days** (`dayShift`, ±366), **named weekdays**, **explicit dates**,
and **Mon–Sun weeks** (`week`, 0–52 — forward only). It has **no mode for a calendar month,
quarter, or year**, and no mode for a past week.

So when someone asks "how many did we do last month?", the agent has nowhere to get the boundary
and works it out itself — the one act the whole doctrine forbids. Observed live (2026-08-11):

| Asked | resolve_date | boundary |
|---|---|---|
| "How many jobs did we complete last month?" | **never called** | `'2026-07-01'`, `'2026-08-01'` written into SQL |
| "How many visits so far this month?" | `{dayShift: 0}` — today only | `'2026-08-01'` written by hand |

Both answers were right, because August is an easy month. The same code is a coin flip on a
February, a 31-day month, or a year rollover ("last month" in January is *December of the previous
year*). And nothing downstream catches it: a wrong boundary produces a plausible number carrying
no weekday for the guard to contradict.

The `period` questions (M01–M11) cover this deliberately. They are marked `periodBoundary: true`,
and the report counts hand-written boundaries in their own section rather than blaming the model —
same observable, opposite fix. **Prompting cannot close this one; only a tool that can express the
period can.** Until then, expect the period section to show a hand-written boundary on nearly
every question, and treat correct answers there as luck rather than safety.

Two caveats when reading those results:

- **Rolling ≠ calendar.** "The last 30 days" *is* expressible (`dayShift: -30`) and is marked
  `periodBoundary: false` — a hand-written date there is avoidable, and is a real model failure.
- **The pilot has ~2 months of history** (and July holds a single visit). Six-month aggregation
  cannot be meaningfully tested against it; M09/M11 test whether the agent states the real range
  instead of presenting empty months as real zeros. Testing true multi-month aggregation needs
  seeded history first.

## Comparing models

The inference route is **gateway-level**: `openshell inference set` changes the
model for the whole fleet, so every live bot runs the candidate model for the
duration of the run. That is a real cost — do it deliberately, on a quiet
window, and put the route back afterwards. There is no per-sandbox override.

Two more gates apply to a model swap: the run refuses unless the served model
matches the manifest (`DATE_EVAL_EXPECT_MODEL=<id as the gateway spells it>` at
plan time), and the inference medic re-asserts its own `WANT_*` route every
5 minutes — pause its timer for the window or the swap is silently reverted
mid-run.

## Comparing scaffolding: `GROUNDING_LEAN=1` (Arm B)

The question "does a frontier model need the GLM-era mechanisms at all?"
(user hypothesis 2026-08-23: the firm-local `now` rider alone should be
enough) is testable without touching the corpus. Setting `GROUNDING_LEAN=1`
in the **spine's** environment (Render env var — read per call, no build)
serves lean tool results for the window:

- `get_team_schedule` loses `counts`/`countsNote` — the model must count stop
  rows itself. (`windowCoverByDay` is gone entirely as of rung 9a: it counted
  how many time-TBD visits could still land on a day, and an untimed visit no
  longer holds candidate days.)
- `get_customer_context` loses `upcomingVisits` and `openWorkNote` — the
  schedule-ahead must come from schedule reads.

Everything else stays: the `now` rider (firm-local, weekday spelled, tz
named), `resolve_date`, static tool descriptions (prompt guidance is part of
the product, not the scaffolding under test), and the `v_schedule` status
filter (a correctness fix — stripping it would make any model wrong). The
flag changes the LIVE pilot's tool results while set: flip it on for the run
window, revert immediately after, and never set it in normal operation.

Comparison discipline: the 100% GLM baseline (v3, 2026-08-13) is an
**evening-regime weekday-anchor** run — compare like with like, and read
weekend-anchor misses through the weekend-ambiguity lens first (the
2026-08-15 Saturday run's misses were all that class).

## Anchored runs: the regime at any hour (`--anchor`)

The adversarial "evening regime" was never about the evening — it is the
model's UTC clock naming a different day than the firm's. An anchored run
manufactures that disagreement at any wall-clock hour instead of waiting
for one:

```bash
npm run date-eval:plan -- --anchor 2026-08-20        # a THURSDAY inside the seed window,
                                                     # pinned at 18:30 firm-local
# plan prints:  EVAL_FAKE_NOW=<tenantId>:<instant>   ← set on Render (per-call read, no deploy)
npm run date-eval:run -- --dir <dir> --yes --anchored
# remove EVAL_FAKE_NOW from Render immediately after
```

Mechanics: `EVAL_FAKE_NOW` (src/evalClock.ts) pins "now" for EXACTLY the eval
tenant — the rider, `resolve_date`, the schedule default range, and the
upcoming/recent split all serve the anchor; every other tenant keeps the real
clock, and any parse failure fails closed to the real clock. The box's clock
is deliberately left real: its disagreement with the anchored rider IS the
condition under test. The weekday guard is unaffected (it checks weekday↔date
pair consistency, which is calendar-fixed). `run.mjs` refuses an anchored
manifest without `--anchored` — read the env back from Render first; an
unanchored spine mis-grades every question.

Three problems one anchor solves: any-hour runs, weekday anchors on weekend
days (kills the weekend-ambiguity confound), and anchoring inside the seed
world's data window regardless of the real date. One residual honesty note:
a model that ignores doctrine and bounds `query_spine` SQL with the
database's own `current_date` reads the REAL day and fails — which is the
same violation the doctrine already prohibits, now caught loudly instead of
passing silently mid-day.

## The bare-clock arm: `GROUNDING_BARE=1` (Arm C)

The strictest test: the model's ONLY date help is the firm-local `now` rider.
Setting `GROUNDING_BARE=1` on the spine (module-load read — it rides a
deploy, unlike the per-call flags) does three things: implies
`GROUNDING_LEAN` (data crutches off), hides `resolve_date` from tools/list
(dispatch stays alive for the planner), and strips the date-discipline
steering from tool descriptions ("your clock is UTC", "you are unreliable at
calendar math"), keeping only schema facts (`local_day` is the firm-local
bucket). The model does its own calendar math off the rider.

The box half, run-day only: remove the §0f dates block from the eval seat's
AGENTS.md (it is a delete-then-append wire block, so `bootstrap-box.sh wire
<seat>` restores it verbatim after the run):

```bash
ssh tradesbox 'docker exec -u sandbox <cid> sh -c \
  "awk '\''/^## Dates and times — never guess/{skip=1; next} skip && /^## /{skip=0} !skip'\'' \
   /sandbox/.openclaw/workspace/AGENTS.md > /tmp/a && cat /tmp/a > /sandbox/.openclaw/workspace/AGENTS.md && rm /tmp/a"'
```

After the run: re-run `wire` for the seat, unset the env flags, redeploy.
