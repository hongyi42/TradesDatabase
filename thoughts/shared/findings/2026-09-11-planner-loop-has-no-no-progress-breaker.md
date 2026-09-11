---
date: 2026-09-11
task: planner loop has no no-progress breaker: one tick repeated the same call ~600x and spent $8.67
status: complete
origin: 20260910-a-promised-visit-was-never-booked-and-th
files: src/model/toolLoop.ts, src/teamLead/planner.ts, src/jobs/lifecycle.ts, scripts/ticks/report.mjs, thoughts/shared/plans/2026-09-11-the-planner-stops-when-it-stops-learning.md, src/eval/plannerSim.test.ts, src/model/toolLoop.test.ts, src/jobs/lifecycle.test.ts, src/teamLead/planner.test.ts, docs/engineering-memory.md
supersedes: nothing
---

## Files

- src/model/toolLoop.ts
- src/teamLead/planner.ts
- src/jobs/lifecycle.ts
- scripts/ticks/report.mjs
- thoughts/shared/plans/2026-09-11-the-planner-stops-when-it-stops-learning.md
- src/eval/plannerSim.test.ts
- src/model/toolLoop.test.ts
- src/jobs/lifecycle.test.ts
- src/teamLead/planner.test.ts
- docs/engineering-memory.md

## Notes

JOB. The 2026-09-11 19:30Z heartbeat tick (pilot firm 82bbc6f8) ran 620 turns until the 15-min clock killed it (Render log: "tool loop exceeded its 900000ms budget after 620 turns"). Cost $8.67 of the planner's $10.21 that day; month-to-date was $15.11. It then exhausted the OpenRouter key's MONTHLY limit: every tick since 20:31Z fails `inference 403: Key limit exceeded`, and the planner stays down until the user raises the limit.
OBSERVED (cost_events, per call): turns 1-13 varied (170/246/192/... output tokens); from turn 14, 602 turns emitted EXACTLY 73 output tokens, and from turn 20 the prompt grew EXACTLY +116 tokens per turn. So it made the same call and got the same answer ~600 times, about 1.5s apart: a model repetition loop. Only one spine_read (19:30:45, Tom Becker's visit, job fe8f98b1), no memory writes, no decisions, no logged message drops. Items in view: edb40884 (Hman's overdue visit; Hman has NO assistant, so unreachable) and 5dc3cd51 (already asked). WHICH call it repeated is UNKNOWN: ticks keep only counts, and OpenRouter's generation API has metadata only. Cost is quadratic because each turn resends the whole history. Caching worked (99.8% cached); without it the tick would have cost ~$45.
PROPOSED (not yet ruled on by the user; they parked this to spawn a session for it): (1) record tool NAMES + counts per tick, e.g. plans[].toolsUsed = {read_memory: 612, submit_plan: 1}. No customer text, so it may go in lifecycle_runs, unlike plans[].refusals from PR #230. (2) A NO-PROGRESS breaker: end the loop when the SAME call (tool + args) returns the SAME result N times in a row (say 5). It must NOT be a turn ceiling: user ruling build 1b, "no maximum number over the planner's head", time is the only rail. Today it would have stopped around turn 19, for cents. Ask the user for N and the design before building.
ALSO SEEN, possibly its own item: the 20:01 tick texted Sam about Hman's visit GAP-LESS (nudgeId null), so edb40884 still has asked_at NULL and the next tick may text Sam again. And the naming rail's hint "leave `to` out to reach the gap's own person" points back at Hman, who is unreachable.
Worth promoting once built: an OpenRouter "Key limit exceeded" 403 can come from ONE looping tick, not from gradual spend.

## Handoff 2026-09-11T21:33:31.415Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/planner-loop-has-no-no-progress-breaker on work/planner-loop-has-no-no-progress-breaker, from origin/main 697aaba.

Overlap check: 6 overlaps with active tasks — the operator read them and proceeded (--proceed):

  MED   changed signature   src/teamLead/plannerPrompt.ts › PLANNER_SYSTEM
        20260910-a-promised-visit-was-never-booked-and-th changed its signature (10 lines); called at 1 site in 1 file 20260911-planner-loop-has-no-no-progress-breaker names (src/teamLead/planner.ts); 1 module imports it repo-wide
  LOW   same file only      scripts/ticks/report.mjs
        20260910-a-promised-visit-was-never-booked-and-th changed internal code only; 20260911-planner-loop-has-no-no-progress-breaker names it
  LOW   same file only      src/jobs/lifecycle.ts
        20260910-a-promised-visit-was-never-booked-and-th changed `redactForRecord` (body, 5 lines); 20260911-planner-loop-has-no-no-progress-breaker names it
  LOW   same file only      src/teamLead/planner.ts
        20260910-a-promised-visit-was-never-booked-and-th changed `PlannerRefusal` (added, 6 lines), `noteRefusal` (added, 23 lines), `PlannerTenantPlan` (signature, 1 line), `runPlanner` (body, 9 lines); 20260911-planner-loop-has-no-no-progress-breaker names it
  LOW   changed behaviour   src/teamLead/planner.ts › runPlanner
        20260910-a-promised-visit-was-never-booked-and-th changed what it does (9 lines); called at 3 sites in 1 file 20260911-planner-loop-has-no-no-progress-breaker names (src/jobs/lifecycle.ts)
  LOW   same file only      src/teamLead/planner.ts
        20260910-planner-s-manager-facing-copy-needs-a-fo lists it but has not changed it; 20260911-planner-loop-has-no-no-progress-breaker names it

## Handoff 2026-09-11T22:14:42.894Z

**What changed** — The shared tool loop now notices when it has stopped LEARNING: it fingerprints every (tool, arguments, exact result) it has seen across the whole call (sha1-hashed — 600 turns x 8 results of up to 20k chars is ~96MB verbatim), and counts only turns whose every call it had already made with the identical answer. At MAX_STALLED_TURNS = 5 it TELLS the model in a note and resets; five more of the same throws ToolLoopLimitError('stalled'). Worst case 11 turns instead of 620. Ticks now record `toolsUsed` (tool names + counts) and `stalledWarnings`; a stalled hit turns the Render run red like a budget hit, and `npm run ticks` prints the per-firm tool tally.

**Decisions** — N = 5 (user). "A turn that learned nothing new" over "identical to the previous turn": same code cost, and it also catches an A->B->A->B cycle. TELLING the model beat killing the tick (user, mid-build, flipping my brief's recommendation): "we should tell the model and let it decide... give it the option to give up on something, close it" — and because a stall is DETERMINISTIC, a killed tick would die identically every half hour, red forever and planning nothing. The note rides BESIDE the tool results (new `note` arg on the transport seam), never inside one: a result is evidence the planner may quote (CITABLE_TOOLS -> readText -> the quote check), so machinery's words inside one could be laundered into an evidence-basis close — this is what removed my objection to telling. Tool names are ALLOWLISTED, unknown ones bucket as '(unknown)': a model may emit any string as a tool name and lifecycle_runs has no tenant_id. Checked against build 1b before building: its rejected rules were skip-the-next-tick and shrink-the-work — this is neither, it is not a turn ceiling (`maxTurns: null` untouched), and 1b explicitly kept the door open "if the numbers call for it".

**Assumptions** — That a real GLM 5.3 repetition loop repeats BYTE-IDENTICALLY; if any result carries a timestamp the fingerprints differ and the breaker never fires (the tool tally is what would reveal that). That the Anthropic wire accepts a text block after tool_result blocks in one user turn — checked against the API reference (results must lead the turn; consecutive same-role messages are legal and merged), never exercised live, since production runs the OpenAI-compatible path and Anthropic is only the documented rollback. That one warning is enough: a second stall throws rather than warning again.

**Open** — Committed as 7684a19 but NOT pushed and no PR opened: the user has not asked, so that is the next step and needs their word. No live verification — reproducing a runaway costs another ~$8.67 and the pilot's OpenRouter key limit is already spent, so the planner stays down until that limit is raised; every test here is unit-level against a stubbed fetch. The parent finding's side item is still unclaimed and unparked (the 20:01 tick texted Sam GAP-LESS, so edb40884 keeps asked_at NULL and a later tick may text Sam again) — I offered to park it and have no answer yet.

**Downstream** — `ToolLoopResult` gained a REQUIRED field (`stalledWarnings`) and `PlannerSummary.limitHits` a required `stalled` key, so every loop stub and fixture in plannerSim.test.ts, desk.test.ts, planner.test.ts, lifecycle.test.ts and plannerPass.test.ts was updated; a sibling worktree holding those files will see trivial conflicts. The desk keeps DESK_MAX_TURNS = 4 and so can never reach five wasted turns (no behaviour change there); the eval harness inherits the breaker, which is where a stall pattern should surface before production. This worktree runs its own Supabase stack N=1 (project TradesDatabase-planner-loop-has-no-no-progress-breaker, ports 544xx); supabase/config.toml is deliberately left uncommitted, and cleanup is `npx supabase stop --no-backup` inside the worktree.
