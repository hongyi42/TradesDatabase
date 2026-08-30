---
date: 2026-08-30
task: Build 3 — the planner writes its own memory, reconciles it against the spine, and the lesson machinery retires
research: thoughts/shared/research/2026-08-29-the-planners-memory-the-ground-it-stands-on.md
status: draft
supersedes: nothing
---

**On `supersedes`.** No decision is overturned, but this **retires** a system built by the ⑤
memory-architecture plan of 2026-08-23 (`planner_lessons`, the Reflector, human activation) — a
replacement the user directed on 2026-08-28, not a reversal of its reasoning. The evidence is in the
research doc: 3 proposed lessons on the pilot, **zero active**, so it has never reached a prompt.

> **Over the 300-line guidance, deliberately.** Adversarial review found seven files Phase 3 must
> touch that the first draft missed, and Phase 2 does not compile without part of Phase 3. Splitting
> was considered and rejected for that coupling. If the size still reads as too much scope, the
> natural cut is Phase 3 into its own plan — say so and I will split it.

## Overview

The planner is stateless across ticks. Its only continuity is one line per open gap (*"considered
14×, last: leave"*), and when a gap closes even that vanishes. This gives it **its own memory**:
markdown files it writes and organises, per firm, in a table shaped like a filesystem. The index
rides in every prompt; files are pulled on demand. Doctrine tells it to **reconcile that memory
against the record before planning**, so the database corrects it every tick. It also learns **when
it last ran**, so "five hours have passed" is a fact it can act on.

## Decisions

- **Memory is .md files the planner organises itself, firm-scoped** — user, 2026-08-28. No folder
  schema, no naming convention, no when-to-write rule from us. Firm-scoped because cross-context
  transfer measured *negative* and only abstraction helps; a firm-scoped file already is one.
- **A table shaped like a filesystem** — Render's disk is ephemeral, so real files evaporate.
- **The index is planner-authored `MEMORY.md` + a code-appended orphan footer at RENDER time** (user
  chose this over a pure planner file and over a code-derived listing). The stored row stays 100% the
  planner's words. Why the footer: the index is the planner's *only* listing, so a file it forgets to
  index is unreachable — it cannot `read_memory` a path it does not know, and reconciliation starts
  from the index, so the mechanism meant to keep memory honest is blind to exactly the files that
  fell off it. Write access does not fix that; **discovery** does.
- **Reconcile-first is DOCTRINE, not an enforced phase** — user. Enforcing it needs either a second
  model call per firm per tick or a prerequisite-tool mechanism the loop does not have.
- **No brake on write frequency** — user: *"I'm fine with nothing stopping the 48 rewrites a day."*
- **Memory writes are not captured to L1** — user. They match neither clause of the 2026-07-04
  outbound rule. The `cost_events` row every tool call already writes is the only trace.
- **The planner learns when it last ran** — user. **ONE ROW PER FIRM, upserted** (`tenant_id` PK,
  `last_ran_at`, `last_success_at`), not an append-only log: the prompt needs only the last success,
  per-tick history already lives in `lifecycle_runs.summary` for 90 days, and one row means no
  retention problem. **The caller supplies the instant** — never DB `now()` — so the eval's simulated
  clock stays coherent, the same reason `plannerSim` rewrites `nudge_decisions.decided_at`.
- **A "run" = a tick that reached the model**, recorded via an explicit flag set immediately before
  `runLoop`. **NOT a `finally` on the per-tenant try:** `continue` executes `finally`, and both the
  `no_gaps` (`planner.ts:1766`) and `off_cadence` (`:1799`) paths `continue` from inside it — a naive
  `finally` would stamp a "run" for every skipped firm and make the prompt line false. The marker
  write is wrapped in its own try/catch *inside* the per-tenant try, so a failed marker degrades to a
  `tenantError` rather than aborting every remaining firm.
- **The prompt shows the last SUCCESSFUL run** — the lesson `reflector_runs` paid for in a follow-up
  migration, where a failed call advancing the watermark starved a firm.
- **The index goes BEFORE the clock and gap blocks.** Measured 2026-08-30: on the OpenRouter/GLM path
  the cacheable prefix is system + tool schemas and the user message is the variable tail, so anything
  after the gaps can never join a cross-tick hit. **Provider-specific**: on the Anthropic rollback
  path `cache_control` sits only on the last system block (`toolLoop.ts:295-304`), so nothing in the
  user message caches either way. The ordering is free there, not harmful.
- **`write_memory` with empty content deletes** — and an **omitted** `content` key must behave
  identically. `runToolLoop` performs no JSON-Schema validation (`toolLoop.ts:571-592`), so
  `required` is never enforced and `str()` returns `undefined` for both absent and non-string.
- **Raw accessors in `src/db/`, rails and rendering in `src/teamLead/`** — `src/db/` is an import leaf.
- **The date rail is carried over — `OPEN`, see below.**
- **The Reflector is deleted, not repurposed.** Not a choice: it imports from `lessons.ts` and its
  only output is `planner_lessons` rows. "Reflector as auditor" was a recorded future role, never
  built, and would be a different program (it reads `gap_summaries`, not lessons). **Left unbuilt,
  hole named:** reconcile-first only catches beliefs the record can contradict. *"The manager prefers
  blunt messages"* is unfalsifiable by any spine query and can sit wrong forever.
- **Three rails are lost with lessons, deliberately.** The evidence check, the `[8-hex]` citation
  stamp (the only way to measure whether a memory ever changed a decision), and two-strike retirement
  (no automatic feeder, so costs nothing). The first two are real; reconcile-first replaces them.
- **The pilot's 3 proposed lessons are dropped, not migrated** — user: test data.
- **The eval's `lessons` family (4 scenarios) retires with the machinery.** Porting needs a
  memory-citation mechanism that does not exist; evaluation is an end phase by standing ruling.
- **No to-do bin is seeded and the doctrine is neutral** — user. Neutral means no rule-register
  examples, which would settle by omission whether a to-do list ever appears. Watch both failure
  modes: no to-dos at all, and memory that is all task chatter and no understanding.
- **Budgets** (tunable): `MEMORY_INDEX_MAX = 3000` chars, `MEMORY_FILE_MAX = 4000`, `ORPHANS_SHOWN =
  10`. Bounding the index is about **attention, not money**. `MEMORY_FILE_MAX` is sized against
  `PLANNER_MAX_TOKENS = 8192` shared with `reasoningEffort: 'medium'` thinking: a write that hits
  `finish_reason=length` throws out of `runLoop` and kills the whole firm's tick, not just the write.
  Over-budget writes are **refused with an instructive error** (the `activateLesson` precedent), never
  truncated and never auto-pruned.

### OPEN — needs user input

**Does the date rail apply to a whole memory file?** `cleanLessonText` refuses on a single
`\d{4}-\d{2}-\d{2}` or month-and-day *anywhere* in the text. Proportionate for a 300-char rule; on a
4,000-char document it means one stray date refuses the entire write — and a **to-do file, which you
explicitly want to watch for, is exactly the file that carries dates**. Three options: (a) keep it
whole-file and refuse, naming the offending substring so the planner can fix it; (b) apply it only to
`MEMORY.md`, letting other files hold dates; (c) drop it for memory entirely. Your 2026-08-28
direction said code enforces the date rail, so (a) is the faithful reading — but it may make a to-do
bin unusable, which would answer your observation question by construction.

## Plain-language walkthrough

**Phase 1 — the filing cabinet.** Three tables and their accessors, wired to nothing: one row per
file per firm, a versions table keeping the last ten copies of each, and a one-row-per-firm marker of
when the planner last ran. Nothing about the planner changes.

**Phase 2 — the planner gets hands and a memory.** Two tools, the index and last-run lines in the
prompt, the doctrine paragraph. The first write verb this identity has ever had.

```
   [ system prompt + tool schemas ]   ~6,080 tokens — stable, cacheable
   [ MEMORY.md + orphan footer    ]   <- NEW, placed here for the cache
   [ "you last planned 5h 12m ago" ]  <- NEW
   [ right now it is… / the gaps  ]   ~451 tokens per gap — changes every tick
```

**Phase 3 — the old system comes out.** The lessons table, the Reflector, the daily distillation, the
activation CLI, the LESSONS paragraph, and the four eval scenarios that tested it. The operator
console is replaced by one that prints the memory tree — how we check whether a to-do bin emerges.

## Secrets & env preflight

- **Phase 1, 2:** none
- **Phase 3:** none added. `REFLECTOR_MODE` is *removed from the code* — and it is currently set to
  `shadow` on the `lifecycle-heart` Render service (`docs/engineering-memory.md:3880`), so **delete
  it there too**; it becomes inert rather than harmful, but a live var pointing at deleted code is
  exactly what confuses the next reader.

## Phase 1: The store and the run marker

### What this phase does
Three tables and their typed accessors, wired to nothing. The planner is unchanged.

### Changes required

**`supabase/migrations/20260830120000_planner_memory.sql`** (new)
- `planner_memory(tenant_id uuid not null references tenants(id) on delete cascade, path text not
  null, content text not null, created_at, updated_at, primary key (tenant_id, path))` with
  `check (path ~ '^(MEMORY\.md|[a-z0-9][a-z0-9/_-]{0,120}\.md)$')`. **Keep it a plain single-quoted
  literal** — an `E'…'` string eats the backslash and turns `\.` into "any character". Verified live:
  `MEMORY.md` and `firm/pacing.md` pass; `Memory.md`, `A.md`, `../x.md`, `x.txt` and a newline-forged
  `"x.md\nMEMORY.md"` all fail. The lowercase charset makes **`MEMORY.md` structurally reserved**.
  Note `a//b.md` DOES pass — `//` is `validateMemoryPath`'s job, not the CHECK's.
- `planner_memory_versions(id uuid pk, tenant_id uuid not null references tenants(id) on delete
  cascade, path text not null, content text not null, replaced_at timestamptz default now())`, index
  `(tenant_id, path, replaced_at desc)`. **The FK is required** — without it a tenant delete leaves
  orphan rows forever.
- `planner_runs(tenant_id uuid primary key references tenants(id) on delete cascade, last_ran_at
  timestamptz not null, last_success_at timestamptz)`. One row per firm, upserted.
- Reuse `set_updated_at()` on `planner_memory` — confirmed at
  `supabase/migrations/20260620012321_add_updated_at_trigger.sql:5`, the `tenant_settings` precedent.
- **RLS + `revoke all from anon, authenticated` on all three.** Load-bearing beyond convention:
  `planner_memory` content is rendered into the planner's prompt, so an unprotected INSERT via the
  publishable key is direct prompt injection — the `planner_lessons` migration header's reasoning.
  Required because of `auto_expose_new_tables` in `supabase/config.toml`.
- **Name all three in every cleanup list** (they reference only `tenants`, so no cascade reaches
  them): `scripts/seed.mjs` (the conditional probes at 180-186 and 187-191 are the pattern),
  `scripts/spine-eval/world.mjs` (132/133 and 195/196), and `scripts/agentic-eval/run.mjs:133`
  (`RESET_TABLES`, a hand-copy of world.mjs's list).

**`src/db/plannerMemory.ts`** (new) — accessors only, no validation:
`listMemoryPaths(tenantId)` (path-ordered), `readMemoryFile(tenantId, path)`,
`writeMemoryFile(tenantId, path, content)` (copy the prior row into versions, upsert on
`tenant_id,path`, prune that path to its 10 most recent versions), `deleteMemoryFile(tenantId, path)`.

**`src/db/plannerRuns.ts`** (new): `upsertPlannerRun(tenantId, atIso, ok)` — **caller supplies the
instant**, never `now()` — and `latestSuccessfulPlannerRunAt(tenantId)` reading `last_success_at`.

**`src/db/index.ts`** — export both (line 24, the `tenantSettings` precedent).

Run `npm run gen:types:local` after applying — never `gen:types`, which is `--linked` (the pilot).

### Automated verification
- [ ] `npx supabase db reset` applies cleanly, then `npm run gen:types:local`
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test` pass
- [ ] `src/db/plannerMemory.test.ts`: write to read round-trips; an overwrite versions the prior
      content; the 11th write leaves exactly 10 versions; delete versions then removes;
      `listMemoryPaths` is path-ordered; a CHECK-violating path is rejected by the database
- [ ] `src/db/plannerRuns.test.ts`: upsert keeps ONE row per tenant; `last_success_at` does not move
      on `ok = false`; `latestSuccessfulPlannerRunAt` returns null when never successful
- [ ] `anon` and `authenticated` hold **zero** grants on all three tables

### Live verification (agent-executable)
- Prerequisites: none. Local-stack only — the pilot is untouched until the whole build order is
  evaluated (user ruling 2026-08-29).

### Manual verification — none

---
*Continue to Phase 2 once the automated checks pass.*

## Phase 2: The planner reads, writes, and knows when it last ran

### What this phase does
Two tools, the index and last-run time in the prompt, the reconcile doctrine. **It also removes the
`knownShortIds` lesson-usage rail** (`planner.ts:1979-1990`), which reads `lessonsBlock` — leaving it
for Phase 3 means Phase 2 does not build.

### Changes required

**`src/teamLead/memory.ts`** (new) — the constants above, plus:
- `cleanMemoryText(raw)` — carried from `cleanLessonText` (`lessons.ts:33-44`), per the OPEN decision.
  **Does NOT use `flatten`**: that collapses all whitespace including newlines, and a file is
  multi-line by nature.
- `validateMemoryPath(path)` — the CHECK's regex mirrored in TS for an instructive error, plus
  explicit refusal of `..` and `//` (the CHECK does not catch `//`).
- `escapeForPrompt(text)` — **specify it; do not point at `flatten`**: strip C0 controls except `\n`
  and `\t`, collapse runs of 3+ newlines, and prefix any line that would forge one of the prompt's
  own headings (matching `^[A-Z][A-Z ]{3,}[.:]`, or starting `gap `) with a space.
- `renderMemoryIndex(tenantId)`: `MEMORY.md`'s content, then — only when orphans exist —
  `not in your index: <up to ORPHANS_SHOWN paths>` `(+N more)`. A path counts as mentioned if it
  appears as a substring of the index text. Returns `''` for a firm with no memory: no heading,
  nothing.

**`src/mcp/server.ts`**
- Add `read_memory` (`{ path }`) and `write_memory` (`{ path, content }`) to `TEAM_LEAD_TOOLS`
  (line 1695) and handlers to the `dispatch` switch. **An omitted `content` deletes, exactly as `''`
  does.** `TEAM_LEAD_ONLY_TOOL_NAMES` is derived from the array (line 1781), so the manager-badge
  refusal works for free.
- Add both names to `TEAM_LEAD_TOOL_NAMES` (`identity.ts:22`). **Both lists** — the research found
  `get_customer_context` and `resolve_date` already in the broken state of being on one only.
- Amend the `identity.ts` header and the gate's error string (`server.ts:2374`, *"capped to
  read/ask"*). Record why a memory write passes the rule — neither irreversible (versioned) nor
  externally visible — **and** the novel property: the first model call to mutate durable state
  *inside* the loop, with no post-loop validation stage.

**`src/teamLead/planner.ts`**
- `buildPlannerUserMessage(nowIso, tz, views, memoryIndex = '', lastRun = null)` — replaces
  `lessonsBlock` (line 1519). **The defaults are load-bearing**: `scripts/planner-eval/run.mjs:93`
  calls it with three arguments. **Index first**, then last-run, then clock, then gaps.
- Last-run lines, code-computed in the firm's clock: `You last planned for this firm at <firm-local>,
  <elapsed> ago.` + `You are scheduled to think about it every <everyMinutes> minutes.` First run:
  `This is the first time you have planned for this firm.` `everyMinutes` exists at `:1785`. **Both
  lines or neither** — elapsed time is uninterpretable without the interval.
- `PlannerDeps`: replace `lessons?` (line 362) with `memoryIndex?`, add `plannerRun?`.
- Read the index and last run in the same try/catch shape as the lessons read (`:1886-1891`) — *a
  memory read must never cost the tick*.
- `let reachedModel = false` in the tenant loop; set it `true` immediately before `runLoop` (`:1907`).
  After the loop body, inside the per-tenant `try`/`catch`, call `upsertPlannerRun(tenantId, nowIso,
  ok)` when `reachedModel` — wrapped in its own try/catch so a marker failure cannot abort the tick.
- **Delete the `knownShortIds` rail** (`:1979-1990`).

**`src/teamLead/plannerPrompt.ts`** — new `YOUR OWN NOTES` paragraph beside the existing `YOUR MEMORY`
one (about `recall_decisions`; it stays). Says: the notes are yours, organise them however serves you;
the index above rides in every prompt so keep it short; `read_memory` pulls a file, `write_memory`
saves one, empty content deletes. **Then the reconcile clause**: before planning, check what your
notes claim against what you are being shown and fix what the record contradicts — the record is what
happened, your notes are what you concluded, and the record wins.

**Existing tests and callers this phase MUST update** (each fails otherwise):
`src/eval/toolCases.test.ts:66` and `src/mcp/server.test.ts:7994` pin the team-lead tool list by name;
`src/mcp/server.test.ts:7859` and `:7871` assert the *"capped to read/ask"* text; `src/teamLead/planner.test.ts:122`
(`baseDeps`'s `lessons:`) and `:2183-2210` (two more `lessons:` plus a `LESSONS (` assertion);
`scripts/planner-eval/run.mjs:93`.

### Automated verification
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test` pass
- [ ] `src/teamLead/memory.test.ts`: the date rail behaves per the OPEN decision; a bad path (`..`,
      `//`, uppercase) is refused with the reason; over-budget index and file writes are refused with
      the size AND the budget in the message; `escapeForPrompt` neutralises a forged `LESSONS:`-style
      heading and a forged `gap <uuid>` line while preserving ordinary newlines; `renderMemoryIndex`
      returns `''` for an empty firm, the index verbatim when nothing is orphaned, the footer **only**
      when a path is missing from the index text, capped at `ORPHANS_SHOWN` with a count of the rest
- [ ] `src/teamLead/planner.test.ts`: the index appears **before** the clock line — assert ORDER, not
      presence; the cache decision is the whole point. Plus: last-run lines render; first-run wording
      with no prior marker; a failing memory read leaves the tick intact; **`off_cadence` and
      `no_gaps` firms write NO marker** (the `finally` trap); a completed tick writes
      `last_success_at`, a throwing one moves `last_ran_at` only; a throwing marker write surfaces as
      one `tenantError` and the next firm still runs
- [ ] `src/mcp/server.test.ts`: both tools dispatch for `spine:team-lead`, are refused for a manager
      badge, and `write_memory` with `content` **omitted** deletes exactly as `''` does
- [ ] a test pinning that every `TEAM_LEAD_TOOL_NAMES` entry has a schema in `TEAM_LEAD_TOOL_SCHEMAS`
      or is explicitly listed as known-unreachable — the drift the research found

### Live verification (agent-executable)
- Prerequisites: local Supabase + `.env` with an inference key; `scripts/agentic-eval/run.mjs` drives
  a real model through `plannerSim`.
- [ ] One `runTick` on the local stack with a real model and one seeded memory file. Evidence: the
      captured user message showing the index before the clock, and a `select path, updated_at from
      planner_memory` read-back showing any write landed.

### Manual verification — none

---
*Continue to Phase 3 once the automated checks pass.*

## Phase 3: Retire the lesson machinery

### What this phase does
Deletes the system memory replaces; swaps the operator console for one that prints the memory tree.

### Changes required

**Deleted:** `src/teamLead/lessons.ts`, `lessons.test.ts`, `src/teamLead/reflector.ts`,
`reflector.test.ts`, `src/db/reflectorRuns.ts`, `scripts/planner-metrics/lessons.mjs`.

**`supabase/migrations/20260830130000_drop_planner_lessons.sql`** — `drop table planner_lessons;
drop table reflector_runs;`. No view depends on either, so no `cascade`.

**`src/jobs/lifecycle.ts`** — remove the import (16), `reflect?` (85), the `reflector` field (122),
step 12 (605-635), **and `reflector,` from the return object (649)**.

**`src/teamLead/plannerPrompt.ts`** — delete the `LESSONS.` paragraph.

**Tests and scripts that break** — all must be updated in this phase:
`src/jobs/lifecycle.test.ts:806-870` (an entire `describe('the reflector gate')`);
`src/teamLead/planner.test.ts:2299-2300` (`toContain('LESSONS block')`, `toContain('bracketed id')`);
`src/eval/plannerEvalGraders2.test.ts:114-119`; `scripts/planner-metrics/report.mjs:96-117` (the
"Lesson usage" section) **and** `src/db/plannerMetrics.test.ts:328-338`, which `execFile`s it and
asserts that heading; `scripts/agentic-eval/run.mjs` at `:133`, `:224` and `:243`.

**`src/eval/`** — remove the `lessons` family: scenarios at `plannerCorpus.ts:844-889`, `...LESSONS,`
at `:1080`, the family count at `:1066`, `lessonCited` at `:78`; the grader at
`plannerEvalGraders2.ts:150-172` and `lessonIds` at `:31`; `world.lessons`/`lessonIds` and the seeding
block in `plannerSim.ts` (`:155`, `:174-175`, `:311-326`); assertions in `plannerCorpus.test.ts`
(`:147-156`, `:188`). **Also add `planner_memory` and `planner_runs` to the per-scenario cleanups**
(`plannerCorpus.test.ts:184-188`, `agentic-eval/run.mjs:219-224`) — without it, memory written in one
scenario rides into the next one's prompt. **Log the loss**: 4 scenarios removed, no replacement, the
evaluation phase owns it.

**`scripts/planner-metrics/memory.mjs`** (new, read-only): `npm run memory:planner -- --tenant <uuid>`
prints each path, size, `updated_at`, and whether the index mentions it — how we check whether a to-do
bin emerges. Add to `package.json`; remove `lessons:planner`.

**Cleanup lists** — remove `planner_lessons` and `reflector_runs` from `seed.mjs:180-191`,
`world.mjs:132-133`/`195-196`, `agentic-eval/run.mjs:133`.

**`docs/engineering-memory.md`** — mark build 3 done in §6a; record the three lost rails and the
unbuilt-auditor hole.

### Automated verification
- [ ] `npx supabase db reset`, `npm run gen:types:local`, then `npx tsc --noEmit`, `npm run lint`,
      `npm test`, `npm run build` pass
- [ ] `grep -rn "planner_lessons\|REFLECTOR_MODE\|lessonCited\|runReflector\|reflector_runs" src
      scripts supabase` returns only the two original migrations and the drop migration.
      **Do not grep bare `reflector`** — `cost_events.lane = 'reflector'` is live historical data
      (`src/db/costs.ts:88`, `costs.test.ts:1028`) and must survive.
- [ ] `npm run memory:planner -- --tenant <local uuid>` prints the tree for a seeded firm
- [ ] `npm run decisions:index` regenerated and committed

### Live verification (agent-executable)
- Prerequisites: `.env` (`DATABASE_URL`) — already required by every `scripts/` tool. **Read-only.**
- [ ] `npm run memory:planner` against the pilot returns cleanly with zero rows (nothing deployed),
      confirming the console works against the real schema. Evidence: the output and a
      `select count(*) from planner_memory` read-back.

### Manual verification — none

---
*The plan is complete when Phase 3's checks pass.*
