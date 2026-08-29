---
date: 2026-08-28
topic: The planner's doctrine, rewritten to the 2026-08-28 harness ruling — role, attention framing, and navigation
status: draft for review
research: thoughts/shared/research/2026-08-28-the-harness-audit.md
supersedes: nothing (the current text lives in src/teamLead/plannerPrompt.ts and has no design doc)
---

## Why

User ruling 2026-08-28: the harness provides places, observations and verbs; the planner decides.
The harness's remaining legitimate job is **curating attention — a weighting, never a gate.**

Three specific instructions from the user this document implements:

1. The gap list must read as a **suggestion**, not an assignment.
2. The planner must be **encouraged to search**, with context on how. *"Discourage it from looking
   for information is not wise because we're basically forcing the planner to operate under
   incomplete information, even when we have the information available."*
3. The planner must know **its role**: *"It is the central intelligence of a trades firm. One of
   its purposes is to facilitate and look out for information so that seat agents and the spine is
   operating under optimal conditions (complete information). Now true complete information is
   obviously impossible, so there is a degree to which 'complete' is viable. And that would have to
   be decided by the planner and the lessons it learns about the firm."*

## The contradiction being removed

`spine_read`'s tool description (`src/mcp/server.ts:651`, `SPINE_VIEW_CATALOG`) is a **good** map:
twelve views, their columns, how they join, and the traps that actually bite —

- `v_captures.job_id` is "only the DIRECT stamp and is usually NULL by design — the durable link
  from a note to its job is the visit: join `v_visits` on `source_capture_id`."
- `sensitivity` is NULL on most rows, so `!=` silently hides the normal rows; use `IS DISTINCT FROM`.
- money direction comes from `kind`, never the sign.

The doctrine (`plannerPrompt.ts:213`) then says: **"Do not browse."**

So the planner is handed a map and told not to use it. The instruction came from a real cost — it
had burned turns on `customer_name LIKE '%Okafor%'` — but the fix for *searching badly* is teaching
it to search by id, not forbidding the search.

## Draft replacement text

### A. The opening — replaces "You are the team lead … decide, for each open gap, what should happen next"

```
You are the central intelligence of a trades firm. The firm runs on one shared record — what was
promised, what happened on site, what it cost, what people actually said — and everyone else works
from it. Each technician and each manager has their own assistant, and those assistants answer from
that record. Their answers are only ever as good as what it holds. Keeping it complete enough to
work from is your job.

"Complete" is not a state you will reach, and chasing it as though you could would make you a
nuisance to people trying to do their work. Every firm has a level of detail that is worth the
trouble and a level past which it is not — and the line sits somewhere different for a firm that
bills fixed-price than for one that bills time and materials. Where it sits HERE is yours to work
out. What you learn about it is worth writing down.
```

### B. The list framing — new, sits above the gaps

```
WHAT YOU ARE SHOWN. Below is what we noticed and thought was probably worth your attention: places
the record looks thin. It is a suggestion, not an assignment. Some of it will not matter at this
firm — say so and move on. Things nobody flagged may matter more, and the whole record is open to
you.
```

### C. Navigation — replaces "Do not browse"

```
GO AND LOOK. You can read the firm's whole record with spine_read, and you should whenever it would
change what you decide: what the job actually is, what has been billed, what else is open for that
person, how your past handovers ended. Its description lists every view and how they join. The one
that catches people: a note reaches its job through its VISIT, so join v_visits on
source_capture_id — filtering captures by job_id alone reads as "nobody said anything" on exactly
the jobs where somebody did.

Filter by the ids you were given, never by searching on a customer or job name — name searches miss
and cost you a turn.

Deciding without looking, when looking was available, is the failure that costs most: it puts a
question to a person that the record could already have answered.
```

## What is NOT free

Two of the three are prompt-only. The third is not:

**The citation rule blocks "close by actively seeking information."** Both the doctrine and
`SPINE_VIEW_CATALOG` rule (5) currently say text found through `spine_read` is refused as a
citation; a close must quote the gap's own pre-computed evidence lines. The user's ruling requires
the planner to be able to close on something it went and found.

The fix is to **widen what is citable, not to drop the requirement to cite**: record what
`spine_read` actually returned during the turn, and accept a citation found in it. The audit
guarantee ("show me the words that closed this") survives; the restriction on where those words may
come from does not. This is a change to `validateDecisions` plus turn-scoped read capture — real
work, not a prompt edit.

## What point 3 implies structurally

If the viable degree of completeness is the planner's judgment, then a gap is no longer "a hole a
detector defined." It is **the planner's judgment that the record falls short of viable-complete
here.** Two consequences:

- The planner needs a verb to **open** a gap nobody flagged (`open_gap`), or the observation list
  remains a de-facto gate no matter how it is worded.
- "How complete is complete enough here" is exactly the kind of thing a lesson should hold — which
  makes it a `firm_fact`-typed lesson, not prose in a prompt.

---

# Addendum — the planner's memory is .md files (user direction, 2026-08-28)

Supersedes the lessons design in `src/teamLead/lessons.ts` + `reflector.ts` and everything typed-lesson
in the earlier build sketch.

> "I want the planner to be able to edit it's own memory and organize it as in .md files. ... And
> after each run, they should update their memory."

**Scope: FIRM-SCOPED ONLY** (user choice, 2026-08-28). One tree per tenant. A cross-firm "craft"
layer is deferred, not rejected; paths stay namespaced so it remains reachable.

## Two constraints the design has to respect

1. **The planner's identity is read-only by design.** `TEAM_LEAD_TOOL_NAMES`
   (`src/teamLead/identity.ts:22`) is `spine_read`, `recall_decisions`, `get_customer_context`,
   `resolve_date`, behind a deny-by-default gate whose stated rule is: *"nothing irreversible or
   externally visible may ever dispatch for it; enforcement is mechanism (the gate), never prompt
   text."* A memory write is neither irreversible (versioned) nor externally visible (nobody
   outside the firm reads it), so it fits INSIDE that rationale — but it is the first write verb
   this identity has carried, and the gate must admit it explicitly.

2. **Render's filesystem is ephemeral.** The planner is a cron there, so ".md files" are durable
   only as a table shaped like a filesystem.

## Store

```sql
planner_memory          (tenant_id, path, content, updated_at)  unique (tenant_id, path)
planner_memory_versions (tenant_id, path, content, written_at)  -- rollback for a bad overwrite
```

Tools, added to both `TEAM_LEAD_TOOL_NAMES` and `TEAM_LEAD_TOOLS`:
`read_memory(path)` · `write_memory(path, content)` · `list_memory()` · `delete_memory(path)`

## Loading — push the keys, pull the content

`MEMORY.md` (the index) is rendered into every prompt. Every other file arrives on demand via
`read_memory`. This is the doctrine `historyLine` already states for decision history, applied to
memory.

The consequence worth naming: today `LESSONS_BLOCK_BUDGET` (2000 chars) is a ceiling on **all** of a
firm's accumulated knowledge. Under this it is a ceiling on the **index** only, and the knowledge
itself is unbounded.

## When it writes

The memory tools are available **during** the turn, not as a separate call after it — the planner
writes when it notices something and then submits its plan. No extra model turns. The doctrine says
to close each run by updating memory; whether it does is **measured**, not enforced, per the
2026-08-28 no-limit ruling that moved the safety budget from rails to evals.

## What code still owns

| | |
|---|---|
| paths, filenames, folders, what is worth writing, when to consolidate | the planner's — we supply no schema |
| index budget | physical (context window); code enforces the wall, the planner decides its contents |
| date rail on memory text | output check — a memory is a rule, not an event (`cleanLessonText` already exists) |
| versioning | not a decision; just not discarding data |

## What this retires

`planner_lessons` (proposed/active/retired/stale, strikes, evidence arrays), `activateLesson`'s
human gate, `strikeLesson`'s two-strike retirement (which has no caller today anyway), the
all-knowledge char cap, and **the Reflector as author**.

The Reflector survives as **auditor**: a planner that reads and writes its own memory every thirty
minutes is a loop with no external correction — the ACE context-collapse failure `lessons.ts`
cites as its own founding reason. Something outside the loop has to sample whether the memory is
helping.

## Still distinct from the firm profile

- **Profile** — parameters the HARNESS acts on. The ask window must be a number code can compare
  against, not a sentence.
- **Memory** — what the PLANNER needs to remember.

Writing the profile stays its own verb.
