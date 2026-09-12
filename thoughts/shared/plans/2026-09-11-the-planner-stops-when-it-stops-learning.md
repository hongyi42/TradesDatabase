---
date: 2026-09-11
task: A no-progress breaker for the tool loop — the loop ends a tick that has stopped learning anything (five consecutive turns whose every call it had already made and been given the identical answer to), and every tick records which tools it called and how many times, so the next runaway names itself
research: .claude/work/tasks/20260911-planner-loop-has-no-no-progress-breaker.md
status: complete
supersedes: nothing
---

## Overview

On 2026-09-11 the 19:30Z heartbeat tick for the pilot firm (82bbc6f8) ran **620 turns** until the
15-minute clock killed it. Turns 1-13 varied; **from turn 14, 602 turns emitted exactly 73 output
tokens each** and the prompt grew by exactly +116 tokens per turn — the same call, the same answer,
~1.5s apart. It cost **$8.67** (of $10.21 for the planner that whole day) and finished by exhausting
the OpenRouter key's MONTHLY limit, so every tick from 20:31Z failed `inference 403: Key limit
exceeded` and the planner stayed down until the limit was raised.

Nothing in the loop watches for "I have learned nothing". Build 1b (2026-08-29) removed the turn
ceiling for the planner on the user's ruling — *"I would not try to put a maximum number over the
planner's head"* — leaving the 15-minute clock as the only rail, and a clock cannot tell thinking
from spinning. Runaways were left **measured, not policed**; this is the first one measured.

And the instrument could not name it: a tick keeps `turns` and `toolCalls` as COUNTS, so **which**
call repeated 600 times is still unknown. `cost_events` has per-call token counts and OpenRouter's
generation API has metadata only.

## Decisions

- **This is NOT a turn ceiling** (build 1b ruling stands). It never counts a turn that learned
  something; a planner doing genuine long-horizon work is untouched.
- **What counts as no progress (user, 2026-09-11): a turn that learned nothing new.** The loop
  fingerprints every `(tool, arguments, exact result string)` it has seen this call; a turn is
  wasted when EVERY call in it is one already seen with the identical answer. Chosen over
  "identical to the previous turn" — same code cost, and it also catches an A→B→A→B cycle, which
  previous-turn comparison never notices.
- **N = 5 (user, 2026-09-11).** The first occurrence is progress, so five wasted turns follow it:
  on the 19:30Z tick the breaker fires at **turn 19**, for under a cent against $8.67. The choice
  between 3, 5 and 10 is pennies either way — it buys rope, not savings.
- **WHEN IT TRIPS, THE MODEL IS TOLD — it is not killed (user, 2026-09-11, overriding the brief's
  recommendation).** *"I think we should tell the model and let it decide. We can give it the
  option to give up on something, close it, or what not."* At `MAX_STALLED_TURNS` the loop says so
  in a note, resets the counter, and the model decides: finish, leave something unsettled, give it
  up. Only a further `MAX_STALLED_TURNS` of repeats throws `ToolLoopLimitError('stalled')`.
- **Why telling beats killing, in the user's own reasoning:** *"If we kill the tick, in the next
  tick, it might hit the same thing and might run over and over again on the same loop issue. With
  the ticks forced to stop every time."* A stall is DETERMINISTIC — same firm, same rows, same
  prompt — so a killed tick dies identically at 20:00, 20:30, 21:00: red forever, planning nothing,
  until a human intervenes. A told tick can still finish.
- **The note rides BESIDE the results, never inside one.** This is what removed the brief's
  objection to telling. A tool result is evidence the planner may quote (`CITABLE_TOOLS` results
  feed `readText`, which the quote check reads), so machinery's words inside one could be laundered
  into an evidence-basis close. Delivery is a new `note` argument on the transport seam: on the
  OpenAI wire a plain `user` message after the tool messages; on the Anthropic wire a text block
  after the `tool_result` blocks in that same user message (tool results must lead the user turn;
  consecutive same-role messages are legal and are merged — verified against the Anthropic API
  reference, 2026-09-11, since `MODEL_PROVIDER=anthropic` is the documented rollback path).
- **The note says WHAT, not HOW** ([[doctrine-says-what-not-how]]): these answers will not change —
  try a different angle, or finish with what you have; leaving something unsettled, or giving up on
  it, is legitimate. It never names the caller's own verbs — a caller whose doctrine has better
  words for "give up" already taught them in its system prompt.
- **"Try a different angle" is offered FIRST (user, 2026-09-11):** *"tell it to look another
  direction."* The first draft said only "finish or give up", which closes doors without opening
  one; a model stuck on one approach often has a better one available once it is told the current
  line is exhausted. Held to ONE clause — PR #226 is what a recipe costs (a one-turn close became
  38 turns).
- **The backstop stays (user, 2026-09-11, after weighing removing it).** Telling is a guess about
  what breaks a repetition loop; if the model reads the note and repeats anyway, the alternative to
  stopping is the original incident — the full clock, ~600 turns, ~$8.67, every tick. The firm's
  plan is lost either way once telling has failed; the stop only decides what finding that out
  costs. It is NOT an alternative to telling, it is what catches telling having failed.
- **A tick that was told and RECOVERED is recorded** (`plans[].stalledWarnings`, fed by a new
  `onStall` hook). Otherwise it is indistinguishable from a healthy tick, and "this firm has to be
  told every time" is the signal that its PROMPT needs work rather than its clock.
- **Tool names + counts per tick** (`plans[].toolsUsed`), counted in `onResult` so they survive the
  throw. Names only — no arguments, no customer words — so unlike `plans[].refusals` the durable
  record keeps them whole. **Names are ALLOWLISTED**: an unknown name is model-authored free text,
  and `lifecycle_runs` has no tenant_id, so anything off the tool list buckets as `(unknown)`.
- **The breaker lives in the shared loop**, not in the planner. The desk keeps `DESK_MAX_TURNS = 4`,
  so it cannot reach five wasted turns — no behaviour change there today; the eval harness gets it,
  which is where a stall pattern would surface before production.

## Phase 1 — the breaker

`src/model/toolLoop.ts`: `MAX_STALLED_TURNS = 5`; `ToolLoopLimit` gains `'stalled'`; a `Set` of
**hashed** fingerprints (sha1 of name + canonical args + result — the raw strings are up to
`MAX_TOOL_RESULT_CHARS` each and 600 turns × 8 calls of those is ~96MB); `LoopTransport.toolResults`
gains the `note` argument; `ToolLoopResult` gains `stalledWarnings`; `ToolLoopRequest` gains
`onStall`. The note, the log line and the error all name the repeated TOOLS, never the arguments —
all three reach a cron log, and arguments can carry a customer's words.

Worst case is now `2 × MAX_STALLED_TURNS + 1 = 11` turns instead of 620.

Tests (`toolLoop.test.ts`): the model is told and the note is a user message, not a tool result;
telling then repeating throws `limit: 'stalled'` at exactly 11 turns; an A→B→A→B cycle is caught
(the whole call is remembered, not just the previous turn); the same call with a CHANGING answer is
progress and never stalls.

## Phase 2 — the tally through the record

`planner.ts`: `PlannerTenantPlan.toolsUsed`, filled in `onResult`, carried on BOTH the success and
the catch path (like `refusals`); `limitHits` init gains `stalled`. `lifecycle.ts`: a `stalled` hit
turns the run red; `redactForRecord` passes `toolsUsed` through with a comment saying why it is
safe. `scripts/ticks/report.mjs`: count `stalled`, explain it in the limits line, print the per-firm
tool tally. Tests: `planner.test.ts` (tally on success and on a failed tick, `(unknown)` bucketing),
`lifecycle.test.ts` (a stalled hit is red; fixtures updated).

## Phase 3 — gates and record

`npm run typecheck && npm run lint && npm test && npm run build`, an `engineering-memory.md` entry,
`npm run decisions:index`, PR.

## Verification

Unit-level only, deliberately: reproducing a live runaway costs another $8.67 and the pilot's key
limit is already spent. The loop's caps are all proven this way today (`toolLoop.test.ts` drives a
stubbed fetch), and the breaker is deterministic — same fingerprints in, same throw out. What CANNOT
be proven here is that a real GLM 5.3 repetition loop produces byte-identical results; if it varies
(a timestamp in a result, say), the fingerprints differ and the breaker never fires. The tool tally
is the instrument for that: the next runaway names its tool and shows whether the answers repeated.
