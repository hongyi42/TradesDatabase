---
date: 2026-08-30
task: Per-job notepads — a place the planner writes what it understands about one job
research: thoughts/shared/research/2026-08-30-per-object-notepads-on-the-spine.md
status: complete
supersedes: nothing
---

**On `supersedes`.** No document is overturned. The 2026-08-19 decision keeping model prose out of
`jobs.attributes`
(`supabase/migrations/20260820120000_nudge_decisions.sql:12-15`) is **upheld**, not overturned: this
plan puts notepads in their own table, planner-private.

## Overview

The planner has firm-scoped memory (build 3) but nothing per job. Its words about a job live only as
per-gap decision rows, and when the gap closes nothing points at them. This gives every job a
**notepad**: one piece of prose the planner writes and re-reads, addressed by the job's own id rather
than by the memory index.

**Split from a sibling plan.** The user also decided to drop `gap_summaries` (write-only since build
3 deleted the Reflector). That retirement has no dependency on notepads and is planned separately in
`thoughts/shared/plans/2026-08-30-retire-gap-summaries.md` — two independent changes, two PRs.

## Decisions

- **Own table, PLANNER-PRIVATE** — user, 2026-08-30. No `v_*` view, reached only by team-lead tools:
  the `recall_decisions` pattern. Rejected `jobs.attributes` because `get_job` is in `TOOLS` and
  returns `attributes` to **every badge including technicians**, and because `unwrapAttributes`
  (`boardRead.ts:466`, `server.ts:7232`) strips fact bundles to bare values — at which point planner
  prose and a technician-evidenced fact are byte-identical. Rejected a manager-visible view because
  the catalog is shared with `query_spine`, so one exposure is total exposure. A manager read can be
  added later as its own tool; un-exposing a view cannot.
- **Its own verb pair, not a reserved memory path** — user. `read_job_note` / `write_job_note` keyed
  by `jobId`. Reusing `read_memory`/`write_memory` would need `renderMemoryIndex` to exclude the
  prefix from both the orphan scan and `listMemoryPaths`, or every job file counts as an orphan and
  the `not in your index:` footer drowns. Two addressing models, stated plainly: **memory is found
  through the index, notepads through the record.**
- **Build now, accepting the gaps-only write window** — user. A job reaches `buildGapView` only while
  it carries an open registry-known gap (research §3). The planner can still *pull* any job via
  `spine_read`; it simply is not reminded. Builds 6–7 widen this later.
- **One row per job + a versions table — the `planner_memory` shape exactly.** An append-only
  "newest wins" single table was drafted and **rejected on review**: the per-tick metadata read would
  then have to reduce N rows per job client-side, and PostgREST caps results at 1,000
  (`supabase/config.toml:18`), so at 10 versions per job the cap bites at ~100 noted jobs and those
  beyond it lose their note line **with no error**. One row per job makes that read exactly one row
  per job. The cost is a second table; the benefit is that the hot path cannot silently truncate and
  that the shape is byte-for-byte the one already built, tested and reviewed three times in build 3.
  `JOB_NOTE_VERSIONS_KEPT = 10` is what makes the write **reversible** and therefore admissible under
  the dispatch gate's stated rule.
- **`written_at` defaults to `now()`, and `plannerSim` MUST rewrite it** — the
  `nudge_decisions.decided_at` precedent. Deliberately NOT the `planner_runs`
  caller-supplies-the-instant pattern: that write goes through `runPlanner`, which holds `nowIso`;
  this one goes through MCP dispatch, which does not, and threading a clock through
  `dispatchForIdentity` for one column is not worth it. **The rewrite is not optional and Phase 2
  owns it** (review finding): the sim clock and the real clock are not comparable in either
  direction, so an unrewritten `written_at` renders as "written 8h ago" one tick after it was
  written — or negative, on a run that starts before 10:00 firm-local.
- **Empty content is REFUSED, not a delete** — a deliberate divergence from `write_memory`. There is
  no index to keep tidy, so a delete verb buys nothing; refusing keeps this write **strictly
  non-destructive**, which is the cleanest possible answer to "nothing irreversible may dispatch for
  this identity".
- **`JOB_NOTE_MAX = 2000` chars.** Half a memory file, because it is about ONE job: a note needing
  4,000 characters is the wrong shape, not a note that needs more room. Refused, never truncated
  (the `activateLesson` precedent).
- **The gap block announces a note only when one EXISTS.** `historyLine` returns null when there is
  no history and this mirrors it exactly. Announcing absence on every gap would be a standing nudge
  to write one, which is the churn hazard build 3 already had to bound.
- **Tenant scoping is checked in code, not left to the FK.** A `job_id` FK proves the job exists,
  never that it belongs to the caller's firm — the `get_job` handler's own guard
  (`src/mcp/server.ts:2856`) is the pattern.

## Plain-language walkthrough

**Phase 1 — the notepad drawer.** Two tables — one note per job, plus the last ten previous copies
of each — with their accessors and rails. Wired to nothing; the planner is unchanged.

**Phase 2 — the planner gets the drawer, and is told it exists.** Two tools, plus one line in each
gap block when that job already has a note. That line is the whole difference between a notepad and
a second write-only store nothing reads:

```
  gap 958ad836-…
    kind: overdue_visit_gap
    about: Tankless descaling for Marisol Duarte
    job id: 92c57df9-…
    …
    watched since Friday, Aug 28 — considered 2×, last: extend 16h ago.   <- existing
    you have a note on this job, last written 3h ago. Use read_job_note.  <- NEW
```

## Secrets & env preflight

- **Phase 1, 2:** none. No new env var; nothing is removed from a deployed service.

## Phase 1: The notepad store

### What this phase does
One table and its typed accessors, wired to nothing. The planner is unchanged.

### Changes required

**`supabase/migrations/20260901120000_job_notes.sql`** (new — RENUMBERED from the plan's
`20260831120000`: the gap_summaries retirement landed first at `20260831130000`, and a new
migration must sort after an applied one)
- `job_notes(tenant_id uuid not null references tenants(id) on delete cascade, job_id uuid not null
  references jobs(id) on delete cascade, content text not null, written_at timestamptz not null
  default now(), created_at timestamptz not null default now(), primary key (tenant_id, job_id))`.
  **One row per job** — see Decisions for why the append-only draft was rejected.
  **`written_at` must be SET by the typed layer on every write, not left to the default** — found
  in build, not planned: the default fires on INSERT only and this is an upsert, so on the conflict
  path a note would report the instant it was FIRST written forever. Verified against PostgREST
  directly: `DO UPDATE SET` covers payload columns only, so `created_at` correctly holds.
- `job_note_versions(id uuid pk default gen_random_uuid(), tenant_id uuid not null references
  tenants(id) on delete cascade, job_id uuid not null references jobs(id) on delete cascade, content
  text not null, replaced_at timestamptz not null default now())`, index
  `(tenant_id, job_id, replaced_at desc, id desc)`. **The `id desc` is in the index and in the prune
  ORDER BY on purpose** — `plannerMemory.prune` (`src/db/plannerMemory.ts:76-81`) already paid for
  this: an unordered tie makes eviction nondeterministic, "a flake nobody would diagnose", and this
  plan's Phase-1 test asserts *which* row is evicted.
- **The `job_id` FK with cascade is a deliberate contrast with `nudge_decisions`**, whose `job_id`
  carries no FK precisely so a trace is "not constrained by the job lifecycle"
  (`20260820120000_nudge_decisions.sql:29-31`). A notepad is *about* the job; it has nothing to be
  about once the job is gone.
- **RLS + `revoke all from anon, authenticated`.** Load-bearing: `content` is model-written text
  returned into the planner's tool results, and `auto_expose_new_tables = true` is still set in
  `supabase/config.toml:31`.
- Name **both** tables in every cleanup list (they reference `tenants` AND `jobs`, so the jobs
  cascade *would* reach them — named anyway, eng-memory §1): `scripts/seed.mjs` (the probe loop added
  by build 3 at :188-195), `scripts/spine-eval/world.mjs` (both lists, at :137 and :201),
  `scripts/agentic-eval/run.mjs` `RESET_TABLES` (:134) and the per-scenario deletes (:227-234), **and
  `src/eval/plannerCorpus.test.ts:184-192`**, the per-scenario delete list build 3 extended for
  `planner_memory` — the plan's own stated rule, and the one the first draft missed.

**`src/db/jobNotes.ts`** (new) — accessors only, no validation. Copy `src/db/plannerMemory.ts`'s
structure, including the two fixes its own review produced:
- `readJobNote(tenantId, jobId): Promise<JobNote | null>`.
- `writeJobNote(tenantId, jobId, content): Promise<JobNote>` — archive the prior content FIRST (so a
  failed upsert leaves a redundant copy of still-current text rather than losing the only copy of
  what was about to be overwritten), upsert on `(tenant_id, job_id)`, then prune to
  `JOB_NOTE_VERSIONS_KEPT`. **An unchanged rewrite archives nothing** — build 3's review finding:
  without it, ten identical copies fill the history in hours and the revision somebody wants back is
  already evicted. Prune is best-effort and never throws; it runs after the real write has landed.
- `listJobNoteMeta(tenantId, jobIds): Promise<Map<string, string>>` — jobId → `written_at`.
  **Metadata only, never content**: this is the per-tick batched read behind the gap-block line and
  must not pull prose into a path that renders none. One query, `.select('job_id, written_at')
  .in('job_id', jobIds)` — exactly one row per job, which is what keeps it clear of PostgREST's
  1,000-row cap.
- `export const JOB_NOTE_VERSIONS_KEPT = 10;`

**`src/teamLead/jobNotes.ts`** (new) — the rails, above the leaf:
- `export const JOB_NOTE_MAX = 2000;`
- `validateJobNoteContent(content: string): { content: string } | { refused: string }` — refuses
  empty/whitespace-only with an instructive message, and over-budget with **both the size and the
  budget** in the text.
- `noteLine(writtenAt: string | null, nowMs: number): string | null` — the gap-block line, `null`
  when there is no note (the `historyLine` contract).

**`src/db/index.ts`** — export `./jobNotes.js` beside the build-3 entries (line 25-26).

Run `npm run gen:types:local` after applying — never `gen:types`, which is `--linked` (the pilot).

### Automated verification
- [x] `npx supabase db reset` applies cleanly, then `npm run gen:types:local`
- [x] `npx tsc --noEmit`, `npm run lint`, `npm test` pass (2461 tests)
- [x] `src/db/jobNotes.test.ts`: write→read round-trips; an overwrite keeps the PRIOR content as a
      version (assert the content, not the count — archiving the incoming text instead would pass a
      count check); an unchanged rewrite archives nothing; the 12th write leaves exactly 10 versions
      with the OLDEST evicted and the newest retained (pruning from the wrong end keeps the same
      count, so assert both ends); pruning is per job; `listJobNoteMeta` returns one entry per noted
      job for a batch and omits jobs with no note; `readJobNote` is null for a job never written;
      deleting the JOB removes its note and its versions; deleting the TENANT removes both
- [x] `src/teamLead/jobNotes.test.ts`: empty and whitespace-only content refused with the reason;
      over-budget refused with size AND budget in the message; exactly at budget accepted;
      `noteLine` returns null with no note and an elapsed-time line with one
- [x] `anon` and `authenticated` hold **zero** grants on `job_notes` AND `job_note_versions`, and RLS
      is on for both (the build-3 ACL test pattern, `src/db/plannerMemory.test.ts:175`)

### Live verification (agent-executable)
- Prerequisites: none. Local-stack only — nothing reaches the pilot until the whole build order is
  evaluated (user ruling 2026-08-29).

### Manual verification — none

---
*Continue to Phase 2 once the automated checks pass.*

## Phase 2: The planner reads, writes, and is told

### What this phase does
Two tools, one batched per-tick read, one line in the gap block, one prompt paragraph.

### Changes required

**`src/mcp/server.ts`**
- Add `read_job_note` (`{ jobId }`) and `write_job_note` (`{ jobId, content }`) to `TEAM_LEAD_TOOLS`
  (the array runs :1703-1811) and handlers to the `dispatch` switch beside the memory cases (:5559,
  :5581). `TEAM_LEAD_ONLY_TOOL_NAMES` derives from the array (:1836), so the manager refusal is free.
- **Both handlers resolve the job and check `job.tenant_id === tenantId` before touching notes** —
  the FK proves existence, never ownership. Mirror `get_job`'s guard (:2856): an unknown or
  cross-tenant id reads as not found, never as an error that confirms the row exists.
- `read_job_note` on a job with no note returns `{ status:'ok', jobId, exists:false, note: … }` —
  absence stated in words, the `recall_decisions` precedent, so the model does not burn a turn
  retrying.
- `write_job_note` refuses a non-string `content` rather than treating it as empty (the build-3
  finding: `str()` cannot distinguish absent from wrong-typed, and destroying prose over a malformed
  argument is unrecoverable from the planner's side).
- Add both names to `TEAM_LEAD_TOOL_NAMES` (`src/teamLead/identity.ts:37`). **Both lists** — the
  pairing test at `src/mcp/server.test.ts:8218` fails otherwise, which is the point of it.
- Amend the gate's error string (:2430) — it currently reads *"capped to reading, asking and its own
  notes"*, which still covers this; **confirm the wording still reads true rather than changing it**,
  and extend the `identity.ts` header note (:16-29) to record that the second write verb is admitted
  on the same grounds *and* one stronger one: it cannot delete.

**`src/teamLead/planner.ts`** (line numbers verified against this branch — the file moved under
build 3, and the first draft of this plan cited the pre-build-3 positions)
- `buildGapView(…, tz = 'UTC', noteWrittenAt: string | null = null)` — a 9th parameter with a
  default, added after `tz` (signature at :726-735). **The default is load-bearing**: the callers are
  `scripts/planner-eval/run.mjs:81`, `src/teamLead/memory.test.ts:297-298`, and ~13 call sites in
  `src/teamLead/planner.test.ts` — one of which (`:2678`) passes only **five** arguments. A defaulted
  9th keeps every one of them valid; none needs editing.
- Push `noteLine(noteWrittenAt, nowMs)` immediately after the `historyLine` push (`:865-866`), so
  the two "you have been here before" signals sit together.
- One batched read per tenant per tick — `listJobNoteMeta(tenantId, jobIds)` — beside the existing
  batched reads (evidence `:1968`, money `:1988`, history `:1993`), reusing the `jobIds` array
  already computed at `:1956-1958`. Skipped when `jobIds` is empty.
- `PlannerDeps` (`:371`): add `jobNotes?: typeof listJobNoteMeta` beside the build-3 entries
  (`:373-378`).
- Wrap the read in its own try/catch — **a note read must never cost the tick**, the same shape as
  the memory read (`:2032-2043`).

**`src/eval/plannerSim.ts`** — **the sim-clock fix-up, and it is not optional.** `runTick` snapshots
tables before the tick (`:406-434`) and rewrites what the tick wrote to `nowIso` (`:498-545`),
because the sim clock and the real clock are not comparable in either direction. Add a fourth
snapshot/rewrite pair for `job_notes` in exactly the `priorDecisionIds` shape (`:410-415` / `:501-519`),
setting `written_at = nowIso`. Without it a note written this tick renders next tick as "written 8h
ago" — or negative on a run starting before 10:00 firm-local — and Phase 2's own live check would be
measuring a line the eval corrupted.

**`src/teamLead/plannerPrompt.ts`** — a `YOUR NOTES ON A JOB` paragraph beside `YOUR OWN NOTES`
(:206). It must say: these are per job and pulled by job id, not through your index; the gap block
tells you when one exists; `read_job_note` opens it and `write_job_note` replaces it; a note cannot
be deleted, so write what you would want to read next time rather than what happened today; and the
distinction that keeps the two stores apart — **your index-notes are what you concluded about the
FIRM, a job note is what you understand about ONE piece of work.**

**Existing tests this phase MUST update (the complete set):** `src/eval/toolCases.test.ts:66` and
`src/mcp/server.test.ts:7994` pin the team-lead tool list by name. Nothing else breaks — the gate's
error string is unchanged, and `plannerCorpus.test.ts:154` derives its tool set from
`TEAM_LEAD_TOOL_SCHEMAS` rather than hard-listing it.

### Automated verification
- [x] `npx tsc --noEmit`, `npm run lint`, `npm test` pass (2474 tests)
- [x] `src/teamLead/planner.test.ts`: the line appears in the block **only** when the job has a note;
      its absence does not otherwise change the block; a failing `listJobNoteMeta` leaves the tick
      intact (`tenantErrors === 0`) and the gaps still render; the batched read is called **once**
      per tick with every gap's job id, not once per gap
- [x] `src/mcp/server.test.ts`: both tools dispatch for `spine:team-lead` and are refused for a
      manager badge; a **cross-tenant jobId reads as not-found**, not as an error, and writes nothing
      (assert via direct SQL that the other tenant's note count is unchanged); empty and non-string
      content are refused and the existing note survives; the pairing test at :8218 still passes
- [x] `src/eval/toolCases.test.ts` and the `TEAM_LEAD_TOOL_SCHEMAS` pin both name four → six tools
- [x] over-budget content is refused **through the tool**, not only through `validateJobNoteContent`
      in isolation — a handler that forgets to call the size branch passes every other check here
- [x] a test asserting `PLANNER_SYSTEM` contains the job-note paragraph and both verb names — the
      prompt-drift lock, added to `describe('PLANNER_SYSTEM — the read surface')` at
      `src/teamLead/planner.test.ts:2529`, beside the build-3 memory pins at `:2560-2577`
- [x] `src/eval/plannerSim.test.ts`: a note written during a tick comes back stamped at the SIM
      instant, not the wall clock — the fix-up above, which nothing else would catch

### Live verification (agent-executable)
- Prerequisites: local Supabase + `.env` with `OPENROUTER_API_KEY`; `scripts/agentic-eval/run.mjs`
  drives a real model through `plannerSim`.
- [x] One `runTick` on the local stack with a real model and a seeded note on the gap's job.
      Evidence: the captured user message showing the note line, and a
      `select job_id, written_at from job_notes` read-back through **direct SQL** showing whether the
      model wrote one. Record honestly whether it read and whether it wrote — build 3's live tick
      read but did not write, and that is the number worth comparing against.
      **Run 2026-08-30, GLM 5.3 via OpenRouter, SMOKE-1 world, note seeded 3h before the tick.**
      The gap block carried `you have a note on this job, last written 3h ago. Use read_job_note
      for it.` and the note's canary string appeared NOWHERE in the prompt — announced, not
      inlined. **The model's FIRST tool call was `read_job_note`**, ahead of `recall_decisions`: it
      followed the announcement unprompted, which is the mechanism working end to end. Direct-SQL
      read-back: **no write this tick** (0 version rows, content unchanged) — the same
      read-but-do-not-write result build 3's memory tick gave.

**Recorded because the plan claimed the opposite:** the RECONCILE paragraph sits in the memory
block and says *"delete it if it has stopped being true"*. Putting the job-note paragraph BEFORE it
made that read as covering job notes, which **cannot** be deleted — the model could only discover
the contradiction by burning a refused turn. The paragraph now sits after the whole memory block.
Found by review, not by a test.

### Manual verification — none

---
*The plan is complete when Phase 2's checks pass.*
