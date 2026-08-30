---
date: 2026-08-29
branch: feat/firm-is-data
commit: 6ae2968
topic: The planner's execution envelope — the 90s loop budget, what it actually bounds, and why exceeding it loses the whole turn
supersedes: nothing
---

## Summary

The planner gets one model conversation per firm per tick, and that conversation runs under a
**90-second wall-clock budget**. This document records exactly what that budget covers, what
happens when it is exceeded, and why the failure is worse than "a slow tick" — it discards work the
model had already finished, and it repeats identically every tick, so a firm that outgrows the
budget never gets planned for again.

It was written after a misreading worth recording: a 70.5-second tick and one budget failure on the
pilot were attributed here to GLM 5.3, when the deploy timeline and `cost_events.provider` both say
they were **Opus 5** on the previous build. GLM 5.3 had not served a single pilot call at the time
of writing. The lesson is in **Open questions**; the budget mechanics below stand on their own and
were traced from the code, not inferred from the incident.

**The user's ruling (2026-08-29), which sets the target for whoever builds this:**

> "Planner model calls occur 30 minutes at a time, so it's ok if it does something truly long
> horizon. I would not try to put a maximum number over the planner's head to constrain it. Though
> I would try to keep it within 15 minutes or so for now. Then we can see if the planner hits that."

So the envelope is a **safety bound, not a design constraint** — sized so the planner is never the
thing that trips it under normal operation, and then measured.

## Entry points

- `src/model/toolLoop.ts:38` — `MAX_TOOL_LOOP_TURNS = 8`
- `src/model/toolLoop.ts:46` — `MAX_TOOL_LOOP_BUDGET_MS = 90_000`
- `src/model/toolLoop.ts:58` — `MAX_TOOL_CALLS_PER_TURN = 8`
- `src/model/toolLoop.ts:444` — `const started = Date.now()` — the budget clock, stamped once
- `src/model/toolLoop.ts:455-461` — the budget check, at the TOP of each turn
- `src/model/toolLoop.ts:538` — the terminal tool returns the loop the instant it succeeds
- `src/teamLead/planner.ts:1733` — `runLoop(...)`, called once per firm
- `src/teamLead/planner.ts:1778` — `const { decisions, dropped } = outcome` — reached only on return
- `src/jobs/lifecycle.ts:461` — the planner cadence gate (`% 30 < 5`)

## What the 90 seconds actually bounds

**One firm's entire planning conversation** — every model call, every tool call, start to finish.
Not one model call, and not one tick.

```
cron */5 ──► one lifecycle run
             ├─ …steps 1-8 (incl. the watcher sweep)
             └─ step 9: runPlanner        (only when minutes % 30 < 5)
                 └─ for each firm, SEQUENTIALLY:
                     └─ runToolLoop   ◄── `started` stamped HERE, once per firm
                         ├─ turn 1: model call ─► up to 8 tool calls
                         ├─ turn 2: model call ─► up to 8 tool calls
                         ├─ …
                         └─ turn 8 (MAX_TOOL_LOOP_TURNS)
                         └── the 90s spans ALL of it
```

Three properties that are easy to get wrong:

1. **Per firm, not per tick.** `runToolLoop` is called inside the tenant loop, so each firm gets its
   own fresh 90 seconds. Firm count does not shrink anyone's allowance. (What firm count *does*
   affect is below.)
2. **It is not merely a between-turn check.** The remaining budget rides into each request as
   `AbortSignal.timeout(remaining)` (`:467`) and into each tool execution via
   `withDeadline(..., left)` (`:522`). A stalled provider aborts rather than holding the tick open,
   and it produces a *different*, distinguishable error — "the provider did not respond within the
   loop's remaining Xms".
3. **`ToolLoopLimitError('budget')` therefore never means "one model call took 90s".** It is thrown
   at the top of a turn, after the previous turn's `turns += 1`. `"exceeded its 90000ms budget after
   1 turns"` means turn 1's model call completed *inside* its own timeout, its tool calls ran, and
   the sum consumed the whole budget.

## What exceeding it costs — the whole turn, not the overrun

`submit_plan` is the loop's **terminal tool** (`toolLoop.ts:538`): the loop returns the moment it
succeeds. So a budget throw is proof the model had not yet submitted.

The plan is captured into `outcome` only when `submit_plan` runs (`planner.ts:1746`), and it is read
at `planner.ts:1778`, **after** `runLoop` returns. A `ToolLoopLimitError` propagates straight past
that line into the per-tenant catch (`:2024`), which writes an `unmentioned` / `refused` row per gap
and applies nothing. There is no partial-application path.

Consequences, in order of how much they matter:

- **It is a ratchet, not a blip.** The budget is deterministic wall clock, so a firm whose work
  genuinely exceeds it fails *every* tick in the same way. The planner is what closes gaps
  (`filled` stopped closing on 2026-08-22), so the open queue grows, the prompt grows, the next tick
  is slower, and the failure becomes more certain. Past a threshold a firm cannot recover on its
  own. The sweep's fail-safe limits the damage — an answered gap still escalates to the manager at
  its deadline — but that is the ladder's emergency exit firing continuously, not the system working.
- **The model cannot see the clock it is judged by.** Nothing in `PLANNER_SYSTEM` or the user
  message states a deadline or the time remaining. The planner has no way to choose "submit what I
  have" over "read one more thing". A deadline the model cannot observe can only be enforced by
  discarding its work.
- **The code names the condition but does not survive it.** `planner.ts:2067-2072` logs the budget
  case distinctly — *"the work no longer fits, this is NOT a model or provider failure"* — and
  `toolLoop.ts:39-45` says to raise the ceiling *here* if measured latencies are tight. Both are
  correct as far as they go; neither preserves a submitted plan.

## The turn ceiling binds before the clock does

`MAX_TOOL_LOOP_TURNS = 8`, and the planner passes no override (`planner.ts:1733-1742` sets
`system`, `user`, `maxTokens`, `label`, `reasoningEffort`, `terminalTool` — no `maxTurns`, no
`budgetMs`). At 8 turns × up to 8 tool calls, one tick can make at most **64 tool calls** and 8
model calls of `PLANNER_MAX_TOKENS = 8192` each.

This matters for the ruling above: raising the time budget alone does **not** buy "truly long
horizon" work. At 15 minutes the loop still stops after 8 model calls — it would simply allow
~112 seconds per turn instead of ~11. If long-horizon planning is the goal, the turn ceiling is the
constraint to examine, and the time budget is the safety net behind it.

## What firm count does affect

Not the per-firm allowance — the **cadence of everything behind a long tick**.
`lifecycle.ts:651-668` records the operational fact: *"Render runs at most one lifecycle cron at a
time and SKIPS an overlapping firing."* Tenants are planned sequentially, so a tick's wall clock is
the sum over firms, and any tick longer than the 5-minute cron interval suppresses the firings
behind it.

**Corrected 2026-08-29 (build 1b): Render DELAYS, it does not skip.** The docs are explicit —
"Render delays the next scheduled run until the active run finishes", and "Render stops an active
run after 12 hours" (https://render.com/docs/cronjobs, verified 2026-08-29). The 15-minute bound is
now shipped rather than proposed.

Arithmetic at the bound, worst case (every firm using its whole budget):

| firms at full budget | tick length | `*/5` firings displaced | planner slot (`:00`/`:30`) |
|---|---|---|---|
| 1 | 15 min | 2, pushed later | survives — 14:00 → 14:15, next slot 14:30 intact |
| 2 | 30 min | 5, pushed later | **missed** — a tick from 14:00 runs through 14:30 |

The planner slot is lost either way, but by a different mechanism than this table first claimed: a
delayed firing *does* run, just at an off-grid minute, and `plannerCadenceDue` (minutes since
midnight % everyMinutes < 5) will not call it due. The every-tick sweep in step 8 is not on a grid,
so it genuinely does run — merely late, which is immaterial against 18h and 24h deadlines.

So the bound is safe for a single-firm pilot and starts eating the planner's own cadence at two
firms, worst case.

**MEASURED, pilot last 24h, ATTRIBUTED BY PROVIDER** — `cost_events.provider` inside each run's
`[started_at, finished_at]`, never by date. The first version of this paragraph quoted the report's
model-blind line (22 ticks, max 4 turns / 34.3s) as GLM's, and **both of those maxima are Opus 5**;
the review caught it. That is the same misattribution this document was written to prevent, made in
the document itself.

| model | planned ticks | turns p50 / max | duration p50 / max |
|---|---|---|---|
| GLM 5.3 (`openrouter`) | 16 | 2 / **2** | 12.2s / **19.3s** |
| Opus 5 (`anthropic`) | 7 | 3 / **4** | 16.4s / **34.3s** |

GLM's worst observed tick is **19.3s against a 900s bound — 47× of headroom**, and its turn count
has never varied from 2. Opus is the slower of the two on both axes. `npm run ticks` cannot make
this split: it reads `lifecycle_runs` only and has no provider column, so its distribution line
mixes every model in the window. This is a tail risk, not the norm; it is the reason the bound
cannot simply keep growing as firms are added.

The suppressed firings also delay the **watcher sweep**, which shares the process. That is far less
serious than it sounds: the sweep's own deadlines (`NUDGE_ESCALATE_HOURS = 24`,
`NUDGE_DELIVERY_DEADLINE_HOURS = 18`) are measured in hours, so losing two five-minute firings is
immaterial to every one of them.

## Constraints and invariants

- **A caller may only ever ask for LESS.** Both ceilings are clamped, not defaulted
  (`toolLoop.ts:476-480`) — a caller cannot raise them, only `MAX_TOOL_LOOP_*` can.
- **The budget must keep riding into the request.** If it became a between-turn check only, a hung
  provider would hold the process past the next tick, which is the failure the abort signal exists
  to prevent.
- **`budget` and `turns` limit hits are counted separately** (`PlannerSummary.limitHits`) and must
  stay separate: they call for opposite responses — a budget hit says the work grew, a turn hit says
  the model is looping.
- ~~**Whatever replaces the hard discard must not let a half-applied plan look like a whole one.**~~
  **VOID — corrected 2026-08-29 (see decision point 3).** A half-applied plan is not reachable: the
  terminal tool returns the loop on the first successful submission, so there is no state in which
  some decisions were applied and the loop then threw. The per-gap `outcome` column is still the
  right shape for recording what happened; there is simply no partial case for it to record here.

## Decision points

1. **Where the bound goes.** Raise `MAX_TOOL_LOOP_BUDGET_MS` 90s → ~900s (the user's 15 minutes), or
   give the planner its own `budgetMs` and leave the shared ceiling where the forced-tool callers
   want it. The planner is the only caller that runs a multi-turn loop today; the other four are
   single-call `runForcedTool` users, which is why the shared constant has not bitten them.
2. **Whether the model is told the clock.** Adding "you have N seconds left, submit now" to the
   prompt makes graceful degradation *possible*; it is also a doctrine change, which is build 6's
   territory. Doing it without build 6 means editing `PLANNER_SYSTEM` twice.
3. ~~**Whether a submitted plan survives a later throw.**~~ **WRONG — corrected 2026-08-29 by
   `thoughts/shared/plans/2026-08-29-the-planner-execution-envelope.md`. There is nothing to
   salvage.** This said `outcome` already holds a submitted plan and that reading it in the catch
   would convert total loss into partial application. It does not, and it would not.
   `submit_plan` is the loop's TERMINAL tool (`toolLoop.ts:581`): the loop returns the instant it
   succeeds, so a successful submission can never go on to hit a limit. The only path that records a
   submission and keeps running is the wholly-refused one (`planner.ts:1930` — every decision
   rejected by the rails), and there `outcome.decisions` is empty by construction. So `outcome` at
   throw time is always either empty, or empty-plus-refusals. What a limit throw destroys is the
   model's *reasoning* — the tool reads, the intermediate conclusions — which only ever existed in
   the message array, and no change to the catch block can reach it. Cross-tick continuity is the
   only mechanism that could, which is build 3's territory (see `docs/engineering-memory.md` §6a,
   "reconcile against the spine BEFORE you plan").
4. **Whether the turn ceiling moves.** Untouched by the ruling, and the actual limit on long-horizon
   work. Raising it without raising the budget does nothing; raising both compounds the tick-length
   effect in the table above.

## Open questions

- ~~**What GLM 5.3 actually costs per tick.**~~ **ANSWERED 2026-08-29.** Its first two real pilot
  ticks (17:30:48Z and 18:00:37Z) ran **16.2s and 12.2s**, 2 turns and 2 tool calls each, one gap,
  `planned` + 1 applied — so **5-9s per model call**. At that rate the 8-turn ceiling stopped the
  loop near 64s and the 90s clock never fired, which is what build 1b acts on. Original text, kept
  because the reasoning it records is what made the measurement necessary: Unknown as of this
  writing: `cost_events` holds zero `provider = 'openrouter'` rows, ever. The OpenRouter build went live on `lifecycle-heart` at
  2026-08-29T04:56:49Z (`dep-da96cq8ae00c73advicg`, commit `8354733`) and no planner tick had run
  since — the ask window holds the planner overnight. **Every latency figure on the pilot to date is
  Opus 5.** Do not size this bound against a model that has not run.
- **How to attribute a tick to a model.** The reliable join is `cost_events.provider` / `sku` within
  the tick's `[started_at, finished_at]` window, plus the live deploy at that instant
  (`list_deploys`). Reading the date alone and assuming the current config produced a false
  attribution once already, in this repo, on this exact question.
- **Where the 90 seconds actually went** on the one observed failure. `cost_events` rows with
  `provider = 'spine'`, `sku = 'tool_call'` are timestamped per call, so the split between model
  time and tool time is recoverable for past ticks — nobody has looked.
