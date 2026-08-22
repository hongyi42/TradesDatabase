---
date: 2026-08-22
task: Measure what the planner WRITES — the manager-facing handoff note — on Opus 5, with explicit prompt caching and per-run cost capture
research: none (design verified against live Anthropic docs, cited below)
status: draft
---

## Overview

Plan ② Phase 3 made the planner the author of one manager-facing string, trading a
signature-checkable guarantee for an eval-measurable one. Only half that trade has been paid: the
rail enforces dates, and **nothing measures blame, over-claiming, length or usefulness.** This is
the other half.

It also answers a live architectural question. The planner and compose are separate partly for
operational reasons and partly on a capability assumption that predates frontier models (user,
2026-08-22). If Opus 5 writes manager copy well, widening it to the technician question is a small
step with receipts. If it does not, we learn *what* it gets wrong. Either way the argument stops
being two people's priors.

## Decisions

- **It measures the REAL prompt, imported from `dist/`** — never a copy. `src/eval/doctrine.ts`
  exists because a copy of the box's doctrine would have measured a paraphrase and reported the
  difference as an agent regression. Same trap here: the whole point is what THIS system prompt
  produces.
- **Anthropic is a new provider path inside the EVAL ONLY.** `src/model/` speaks OpenAI dialect
  (Fireworks/DeepInfra/Nebius). Wiring Anthropic into production is a separate decision with its
  own migration of `recordModelUsage` pricing; this plan does not touch it.
- **One cache breakpoint, on the last system block.** Verified against
  https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching (2026-08-22): prefixes
  build in the order `tools → system → messages`, so a breakpoint at the end of `system` caches the
  tools too. The stable prefix is ~2,744 tokens against Opus 5's **512-token minimum**. The
  per-tick gap blocks go in `messages` and are deliberately NOT cached — they change every call.
- **5-minute TTL for the eval, and the harness says why.** Cache reads refresh the TTL, and eval
  calls fire back to back, so the default `{"type":"ephemeral"}` holds for a whole run at a 1.25×
  write. **Production is the opposite case and the harness must print it:** the planner runs every
  30 minutes, so a 5m cache always expires and every call pays 1.25× — *worse than no cache*. Only
  `ttl: "1h"` (2× write) helps there. Getting this backwards would raise the pilot's bill while
  looking like an optimisation.
- **Cost is captured per scenario, not estimated.** Read `usage.input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` off each response and
  price them. Opus 5: $5/MTok in, $25/MTok out, cache read 0.1× = $0.50/MTok, 5m write 1.25× =
  $6.25/MTok, 1h write 2× = $10/MTok.
- **Two grader tiers.** Deterministic first, because it is free and exact: the date rail (reuse
  `cleanHandoffNote` — the SAME function production runs), length, the job and customer named, no
  dismissal invitation. Then a judge call for the two things only a reader can settle: does it
  blame the person, and does it assert anything the gap block did not contain.
- **The judge never sees the grader's verdict** and is given the gap block plus the note alone, so
  it cannot rubber-stamp. Cheaper model tier than the planner.
- **Scenarios are built from real `Nudge` rows through the real `buildGapView`** — not hand-written
  blocks. A hand-written block is a paraphrase by another name.

## Plain-language walkthrough

**Phase 1 — make the real prompt reachable.** Today the planner builds its per-tick message inline,
so nothing outside `runPlanner` can reproduce it. We lift that assembly into one exported function
that `runPlanner` also calls. Nothing changes about what the planner sends; the eval just gains the
ability to render exactly it.

**Phase 2 — the Anthropic caller.** A small module that speaks the Messages API, forces
`submit_plan`, marks the cache breakpoint, and returns the parsed plan alongside the token counts
and dollars for that one call.

**Phase 3 — scenarios and the run.** Fixtures for the situations that matter — a technician who
never answered, one who answered something unrelated, a job whose money already landed, a gap the
planner already escalated once. `run.mjs` is the only step that spends money, mirroring
`scripts/date-eval/`.

**Phase 4 — grade and report.** Deterministic checks, then the judge, then a report: pass rate per
check, the notes that failed and why, total spend, and cache hit rate.

```
 fixtures ──► buildGapView ──► the REAL user message
                                      │
        PLANNER_SYSTEM + submit_plan ─┤  (cached prefix, 1 breakpoint)
                                      ▼
                                  Opus 5
                                      │
                              handoffNote per gap
                                      │
                    ┌─────────────────┴─────────────────┐
              deterministic                          judge
        (date rail, length, names)          (blame? unsupported claim?)
                    └─────────────────┬─────────────────┘
                                   report + $
```

## Secrets & env preflight

- **Phase 2-4:** `ANTHROPIC_API_KEY` in `.env` — *already present* (verified by name 2026-08-22).
- Phases 1: none.

## Phase 1: Make the real prompt reachable

### Changes required
**`src/teamLead/planner.ts`**
- Export `buildGapView` (currently module-private).
- Extract the inline assembly at `:1085-1092` into
  `export function buildPlannerUserMessage(nowIso: string, tz: string, views: GapView[]): string`
  and have `runPlanner` call it. Byte-identical output — this is a move, not a rewrite.
- Export `GapView`.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] new test: `buildPlannerUserMessage` output for a known view set matches the string
      `runPlanner` sends (assert on the recorded model call, so the two cannot drift)
- [ ] mutation: change the assembly → the equivalence test fails

## Phase 2: The Anthropic caller, cached and costed

### Changes required
**`scripts/planner-eval/anthropic.mjs`** (new)
- `callPlanner({ system, tool, user, model, ttl })` → POST `https://api.anthropic.com/v1/messages`
  with `anthropic-version: 2023-06-01`, `tools: [tool]`, `tool_choice: {type:'tool', name:'submit_plan'}`.
- `system` as a content-block array with `cache_control: {type:'ephemeral'}` (plus `ttl:'1h'` when
  asked) on the LAST block — the breakpoint rule is "the last block whose prefix is identical
  across requests".
- Returns `{ plan, usage, costUsd, cacheHit }`. `costUsd` from the price table above.
- **`tool_choice` must not vary across a run** — the docs list it as invalidating the tools and
  system caches.

### Automated verification
- [ ] a unit test with a stubbed `fetch` asserts the request body places `cache_control` on the
      last system block and nowhere else, and that `tool_choice` is the forced shape
- [ ] cost arithmetic test: a known usage object → the expected dollars, cache read priced at 0.1×

## Phase 3: Scenarios and the run

### Changes required
**`scripts/planner-eval/scenarios.mjs`** — Nudge fixtures + expected facts per scenario.
**`scripts/planner-eval/run.mjs`** — THE STEP THAT SPENDS MONEY. `--yes` required, `--limit N`,
`--ttl 5m|1h`, writes one JSONL row per scenario (prompt, note, usage, cost) into a run dir.

### Automated verification
- [ ] `node scripts/planner-eval/run.mjs` without `--yes` refuses and spends nothing
- [ ] every scenario renders through the real `buildGapView`; a fixture that cannot is a loud error

### Live verification (agent-executable)
- Prerequisites: `ANTHROPIC_API_KEY`
- [ ] a 3-scenario smoke run: report the notes, the per-call usage, and that call 2+ shows
      `cache_read_input_tokens > 0` while call 1 shows `cache_creation_input_tokens > 0`

## Phase 4: Grade and report

### Changes required
**`scripts/planner-eval/graders.mjs`** — deterministic checks, importing `cleanHandoffNote` from
`dist/` so the eval and production share one rail.
**`scripts/planner-eval/judge.mjs`** — one call per note: blame, and any claim absent from the block.
**`scripts/planner-eval/analyze.mjs`** — pass rate per check, every failure quoted, total spend,
cache hit rate, and the 5m-vs-1h production note.

### Automated verification
- [ ] graders unit-tested against hand-written notes: a blaming note, an invented-date note, an
      over-long note, a dismissal-inviting note, and a clean one
- [ ] `analyze.mjs` on a fixture run dir produces the expected counts

### Manual verification
- [ ] Read the failures and judge whether the grader agrees with you — a grader you disagree with
      is the finding, not the notes
