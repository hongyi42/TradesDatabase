---
date: 2026-08-30
branch: feat/planner-memory
commit: 0ff1119
topic: Per-object notepads on the spine — the ground a job-notepad build would stand on
supersedes: nothing
---

**On `supersedes`.** This document overturns nothing. It does, however, surface a decision already
recorded elsewhere that bears directly on the build being contemplated —
`supabase/migrations/20260820120000_nudge_decisions.sql:12-15` deliberately kept model-written
deliberation OUT of `jobs.attributes`, with a stated reason. A plan that puts planner prose there
would be overturning *that*, and should name it.

## Summary

A **notepad** would be a place for the planner to write, in its own words, what is going on with one
job — read and updated as that job evolves, addressed by the job's own id rather than by the memory
index the planner keeps. This document records what exists today that such a thing would sit on top
of, and it turns up four facts that shape the choice more than anything else.

First, **the planner is structurally blind to the one field that already looks like a notepad.**
`jobs.attributes` is the spine's L3 "long tail" column, but `v_jobs` — the only job read the planner
has — names its columns one at a time and `attributes` is not among them. Meanwhile the *only* writer
of `jobs.attributes` is `record_standing_fact`, a **seat-agent** tool. So today the technicians' and
managers' assistants write structured job facts and the planner cannot see them.

Second, **that exclusion was a decision, not an oversight, and it was made about exactly this kind of
content.** The `nudge_decisions` migration header states that planner deliberation stays out of
`jobs.attributes` *"deliberately: `get_job` renders L3 to managers as fact, and a model's
deliberations are the weakest evidence class there is."* Verified: `get_job` returns the whole
`attributes` object and sits in `TOOLS`, so it is reachable by **every badge including technicians**.

Third, **the planner only ever sees a job while that job has an open gap.** Nothing else puts a job
in front of it. Between gaps and after the last gap closes, the job is invisible — which bounds when
a notepad could be written at all.

Fourth, **`gap_summaries` is now write-only.** It is populated every lifecycle tick, and after build
3 deleted the Reflector its two read accessors (`listRecentSummaries`, `countSummaries`) have **zero
callers** in `src/` or `scripts/`. The only code that reads its content anywhere is the eval harness.

## Entry Points

- `src/teamLead/planner.ts:1836` — `runPlanner`'s per-tenant loop; `listNudges(tenantId, [...OPEN_NUDGE_STATUSES])` is the *only* thing that puts a job in the planner's view.
- `src/teamLead/planner.ts:735` — `buildGapView`, which renders everything the planner is told about a job without asking.
- `supabase/migrations/20260806120000_query_spine_reader.sql:108` — `v_jobs`, the planner's only job read.
- `src/mcp/server.ts:2851` — the `get_job` handler, the seat agents' job read (returns `attributes`).
- `src/db/jobs.ts:89` — `trySetJobAttribute`, the sole writer of `jobs.attributes`.
- `src/mcp/server.ts:5559` / `:5581` — `read_memory` / `write_memory`, the precedent write verb.
- `src/jobs/summarize.ts:51` — `runGapSummaries`, the per-closed-gap summary writer.

## Key Files

| Path | Role |
|---|---|
| `src/teamLead/planner.ts` | `buildGapView` (:735), `historyLine` (:647), `GapView` (:589), `buildPlannerUserMessage`, the tenant loop. Constants `EVIDENCE_TEXT_CHARS=600` (:343), `EVIDENCE_PER_GAP=6` (:346), `QUESTION_SHOWN_CHARS=1450` (:350), `UNMENTIONED_CAP=200` (:99). |
| `src/teamLead/memory.ts` | The memory rails: `MEMORY_INDEX_PATH` (:21), `MEMORY_INDEX_MAX=3000` (:25), `MEMORY_FILE_MAX=4000` (:30), `ORPHANS_SHOWN=10` (:32), `validateMemoryPath` (:50), `validateMemoryContent` (:67), `ORPHAN_FOOTER_PREFIX` (:87), `escapeForPrompt` (:147), `renderMemoryIndex` (:180). |
| `src/db/plannerMemory.ts` | Raw store. `MEMORY_VERSIONS_KEPT=10` (:21), `listMemoryPaths`, `readMemoryFile`, `writeMemoryFile`, `deleteMemoryFile`. |
| `src/db/standingFacts.ts` | `StandingFactBundle` (:9), `isFactBundle` (:20), `unwrapAttributes` (:30), `foldRetractedFacts` (:41), `factSourceIds` (:55), `factEntriesCiting` (:66). |
| `src/db/jobs.ts` | `trySetJobAttribute` (:89), `setJobAttribute` (:113), `getJob` (:124). |
| `src/db/nudgeDecisions.ts` | `listDecisionsForNudge`, `listDecisionsForJob` (:191), `recordNudgeDecisions`. |
| `src/db/gapSummaries.ts` | `insertGapSummary` (:15), `listUnsummarizedClosedNudges` (:33), `listRecentSummaries` (:51), `countSummaries` (:64). |
| `src/jobs/summarize.ts` | `runGapSummaries` — the writer; `subjectLabel` (:37), `contextJobId` (:46). |
| `src/teamLead/identity.ts` | `TEAM_LEAD_TOOL_NAMES` (:37) — the allowlist, and the recorded reasoning for the first write verb. |
| `src/mcp/server.ts` | `TOOLS` (:274), `ADMIN_TOOLS` (:741), `TEAM_LEAD_TOOLS` (:1695), the dispatch gate (:2429), `get_job` (:2851), memory handlers (:5559, :5581). |
| `supabase/migrations/20260820120000_nudge_decisions.sql` | The header carrying the "stays out of L3" decision (:12-15). |
| `supabase/migrations/20260823120000_planner_read_surface.sql` | The four planner views, and the header explaining why `nudge_decisions` is view-less (:70-73). |

## Data Flows

### 1. What the planner can see of a job today

**Pushed, without asking — the gap block** (`buildGapView`, `src/teamLead/planner.ts:735`). Every
line, in render order:

```
gap <nudge id>
  kind: <overdue_visit_gap | job_cost_gap>
  about: <context.jobTitle> for <context.customerName>
  job id: <context.jobId>   (filter by this id, never by name)
  person: <context.technicianName>
  state: <pending | queued | asked>
  noticed: <N>h ago
  asked: <N>h ago | not yet
  the question asked: <nudges.question, flattened to 1450 chars>       [if asked]
  THE RECORD: <cost recorded / no cost recorded>                       [job_cost_gap only]
  currently held until: <not_before>                                   [if held]
  escalates automatically at: <ISO>                                    [if asked]
  dates you may use in a handover note, VERBATIM and only these:
    the ask went out / the visit was due / how long ago the ask went out
  watched since <label> — considered <N>×, last: <action> <N>h ago.
      Use recall_decisions for the detail.                             [if any history]
  NOTE: this job has more than one open gap …                          [if sharesJob]
  evidence since <the question went out | this gap was noticed>:
    [1..6] <captured_at> via <channel> (<technician_ref>): <raw_text, 600 chars>
  money on this job since …:
    [1..6] <kind> $<amount>, recorded <date>
```

Everything above the evidence block comes from **`nudges.context`**, a JSONB blob the *detectors*
write (`src/jobs/nudgeKinds.ts`), read through `ctxStr` (`planner.ts:444`). The keys the planner
ever sees are exactly: `jobId`, `jobTitle`, `customerName`, `technicianName`, `endsAtLocal`. There
is no other job field in the block.

**Pullable, via `spine_read`** — twelve views. Job-relevant columns, exactly:

| View | Job-relevant columns |
|---|---|
| `v_jobs` | `id, title, job_type, status, priority, duration_minutes, price_cents, created_at, updated_at, customer_id, customer_name` |
| `v_schedule` | `assignment_id, local_day, local_weekday, starts_at, ends_at, status, promise_level, promised_day, locked, earliest_date, latest_date, technician_ref, technician_name, job_id, job_title, job_type, job_status, customer_id, customer_name, city, postal_code` (confirmed/completed only) |
| `v_cancelled_visits` | as above, `reason`/`updated_at` instead of status, cancelled only |
| `v_money_events` | `id, job_id, job_title, customer_id, customer_name, kind, amount_cents, currency, occurred_at, actor_ref, corrects_event_id, method, external_ref` |
| `v_captures` | `id, captured_at, channel, technician_ref, customer_id, job_id, raw_text, sensitivity, retracts_capture_id, retracted, retraction_reason, retracted_at` |
| `v_visits` | `id, job_id, source_capture_id, technician_name, labor_hours, created_at` |
| `v_nudges` | `id, kind, status, subject_ref, technician_ref, technician_name, job_id, question, resolution, answered_by_capture_id, not_before, escalate_after, created_at, queued_at, asked_at, resolved_at, serve_count, attempts` |
| `v_review_items` | `id, kind, status, subject_ref, suggestion, resolution, job_id, technician_ref, escalated_from_nudge, created_at, resolved_at` |
| `v_customers`, `v_team`, `v_time_off`, `v_firm_profile` | no job columns |

**NOT reachable by the planner, at all: `jobs.attributes`.** `v_jobs` names eleven columns and
`attributes` is not one of them. Confirmed across every migration: the only occurrences of
`attributes` in `supabase/migrations/` are base-table definitions
(`20260620005307_context_spine.sql:53,68,84` and `20260620013000_schedule_entries.sql:22`) and two
comments. No view has ever exposed it.

### 2. The asymmetry, stated factually

```
  seat agents (technician + manager badges)      the planner (spine:team-lead)
  ─────────────────────────────────────────      ────────────────────────────────
  record_standing_fact ──► setJobAttribute       spine_read ──► v_jobs
                       ──► trySetJobAttribute                   (11 columns,
                       ──► jobs.attributes                       NO attributes)
  get_job              ──► returns attributes    (no read of attributes exists)
```

- `jobs.attributes` holds `StandingFactBundle` values: `{ value: string|number|boolean,
  sourceCaptureId: string, recordedAt: string }` (`src/db/standingFacts.ts:9`). The bundle **is** the
  provenance link — `isFactBundle` (:20) enforces *exactly* those three keys so a plain attribute can
  never be misread as a fact.
- Its only removal path is retraction of the evidencing capture: `foldRetractedFacts` (:41) drops a
  bundle whose `sourceCaptureId` was retracted. There is no delete tool.
- The only writer is `trySetJobAttribute` (`src/db/jobs.ts:89`), a compare-and-swap on `updated_at`,
  reached only from `record_standing_fact` (`src/mcp/server.ts:3726`).
- `get_job` (`src/mcp/server.ts:2851-2901`) returns `{ ...job, attributes, ...money }`. It is declared
  in `TOOLS` (:354), which is line-order **before** `ADMIN_TOOLS` (:741) — so it is a base tool
  available to **every badge, technician included**, not a manager-only read.

### 3. When the planner sees a job at all

The complete set of conditions, all of which must hold on the same tick:

1. The tenant is returned by `listTenantIdsWithTelegramBindings()` (`planner.ts:1727`).
2. `PLANNER_MODE` is not `off` (`:1717`).
3. The tenant has ≥1 nudge in `OPEN_NUDGE_STATUSES = ['pending','queued','asked']`
   (`src/db/nudges.ts:23`) — otherwise `skippedNoGaps`, `continue` (`planner.ts:1847-1851`).
4. That nudge's `kind` has a spec in `NUDGE_KIND_SPECS` (`src/jobs/nudgeKinds.ts:466`, currently
   exactly `overdue_visit_gap` and `job_cost_gap`) — the registry filter at `planner.ts:1841`.
5. The firm is due by cadence — `plannerCadenceDue(nowIso, everyMinutes)`; otherwise `off_cadence`,
   `continue` (`:1873-1883`).
6. The job id itself comes from `nudges.context->>'jobId'`; a nudge without one still produces a gap
   view, with `jobId: null`.

**The bound this places on a notepad's write cadence:** a job is in the planner's field of view *if
and only if* it currently carries an open, registry-known gap. There is no per-job pass, no
"jobs changed since last tick" read, and no path by which a job with no open gap reaches
`buildGapView`. When the last gap on a job closes, the job leaves the planner's world and nothing
brings it back until a detector mints another gap on it.

### 4. The existing per-job record, and its readers

**`nudge_decisions`** — `supabase/migrations/20260820120000_nudge_decisions.sql`. Columns:
`id, tenant_id, nudge_id, job_id, decided_at, mode, action, not_before, basis, citation, confidence,
reason, outcome, outcome_detail, escalate_after, handoff_note, agent_context, question_draft`.

- `nudge_id` → `nudges(id) on delete cascade`. **`job_id` carries NO foreign key, deliberately**:
  *"this is a trace, and it must not constrain or be constrained by the job lifecycle"* (migration
  :29-31). It is denormalised from `context->>'jobId'` precisely so history can be recalled **by
  job** — *"a job's gaps are the unit a person actually thinks in."*
- Append-only in spirit: no `updated_at`, no trigger, no model-reachable write tool. The stated
  reason is ACE context collapse — *"a context that gets rewritten in place erodes."*
- Nothing in production deletes it. The only deletes are in `scripts/` cleanup lists and the eval.
- Read by `listDecisionsForJob` (`src/db/nudgeDecisions.ts:191`) — tenant- and job-scoped,
  `action != 'unmentioned'`, newest first, limit clamped to `[1, 200]`. Surfaced to the planner as
  `recall_decisions { jobId }` (`src/mcp/server.ts:5466`).
- **No view.** The `20260823120000_planner_read_surface.sql` header states why (:70-73):
  *"nudge_decisions stays deliberately view-less: this catalog is shared with the manager's
  query_spine, and a view there would hand every manager the planner's deliberations."*

**`gap_summaries`** — one code-written row per closed gap. Columns: `id, tenant_id, nudge_id, job_id,
kind, subject, asked_at, closed_at, status, resolution, working_hours_open, arc, considered,
escalated, extended_to, manager_fate, manager_latency_wh, manager_resolution,
answered_by_capture_id, created_at`.

- `subject` is a label, not prose: `"<customerName> — <jobTitle>"`, falling back to `subject_ref`
  (`src/jobs/summarize.ts:37-44`).
- `arc` is a **verb-count histogram**, not narrative: `for (const d of history) arc[d.action] =
  (arc[d.action] ?? 0) + 1` (:136-137). A typical value is `{"extend": 2, "leave": 1}`.
- Written by `runGapSummaries` every lifecycle tick, idempotent on `nudge_id`, with a 7-day
  `HOLDBACK_DAYS` for escalations whose review item is still open.

**Readers of `gap_summaries`, enumerated exhaustively** (`src/`, `scripts/`, excluding tests and the
module itself):

| Accessor | Callers |
|---|---|
| `insertGapSummary` | `src/jobs/summarize.ts` (write path) |
| `listUnsummarizedClosedNudges` | `src/jobs/summarize.ts` (the anti-join that finds what to write) |
| `listRecentSummaries` | **none** |
| `countSummaries` | **none** |

Direct table access outside those accessors: `src/eval/plannerSim.ts:797` only, for grading. Every
other occurrence of the string in `src/`/`scripts/` is a comment or a cleanup-list entry.

**Finding, stated as fact:** after build 3 deleted `src/teamLead/reflector.ts` — which was the sole
caller of both read accessors — **no production reader of `gap_summaries` content remains.** The
lifecycle continues to write one row per closed gap every tick. There is no view over the table
either, so the planner cannot reach it through `spine_read`.

### 5. The two storage precedents

**(a) `planner_memory`** (this branch, `supabase/migrations/20260830120000_planner_memory.sql`).

- `planner_memory(tenant_id, path, content, created_at, updated_at)`, PK `(tenant_id, path)`, with
  `check (path ~ '^(MEMORY\.md|[a-z0-9][a-z0-9/_-]{0,120}\.md)$')`. The lowercase-only charset makes
  `MEMORY.md` structurally unforgeable.
- `planner_memory_versions` keeps the last `MEMORY_VERSIONS_KEPT = 10` per path; an unchanged rewrite
  consumes no slot (`src/db/plannerMemory.ts:105`).
- RLS enabled + `revoke all from anon, authenticated` on all three tables. Load-bearing beyond
  convention: `content` is rendered into the planner's prompt, so an unprotected INSERT via the
  publishable key would be prompt injection.
- **Addressing and discovery — the mechanism most relevant here.** A file is reachable only two ways:
  its path appears in `MEMORY.md`'s text (a boundary-checked mention, `src/teamLead/memory.ts:186`),
  or it appears in the code-appended footer `not in your index: …` capped at `ORPHANS_SHOWN = 10`
  with a `(+N more)` tail. **There is no listing verb.** The planner cannot enumerate paths and
  cannot read a path it has not been shown. The index itself is capped at `MEMORY_INDEX_MAX = 3000`
  characters and rides in every prompt.
- Content rails: `validateMemoryPath` (:50) mirrors the CHECK and additionally refuses `..` and `//`;
  `validateMemoryContent` (:67) enforces the size budget and refuses rather than truncating; there is
  **no date rail** (user ruling 2026-08-30); `escapeForPrompt` (:147) prefixes one space to any line
  that would forge a prompt structure.
- What it guarantees: reversibility (10 versions), a bounded prompt cost, and complete freedom of
  organisation. What it costs: an index that must be curated by the model, and a hard reachability
  ceiling — beyond 10 un-indexed files, paths are unreachable.

**(b) `jobs.attributes` / `StandingFactBundle`** — see §2 above.

- What it guarantees: every fact carries a link to the L1 capture that evidences it, and disappears
  automatically if that capture is retracted. It is addressed by the job's own id, needs no index,
  and has no count ceiling.
- What it costs: the bundle shape is enforced to exactly three keys, and the value is a **scalar**
  (`string | number | boolean`) — `isFactBundle` requires `['recordedAt','sourceCaptureId','value']`
  exactly and `typeof value` in that set. Free-text prose with no single evidencing capture does not
  fit the shape. And anything stored there is returned by `get_job` to every badge.

### 6. How a notepad would announce itself

**The prompt's measured shape** (`docs/engineering-memory.md:4300-4315`, measured 2026-08-30 over 17
GLM 5.3 ticks): the cacheable prefix is system prompt + tool schemas = **6,080 tokens**; the user
message for a one-gap firm is **~451 tokens**. Total 6,531. Cross-tick caching is intermittent
(93% for ten ticks, then 0% for seven); within a tick it is flawless.

Gap-block size is bounded by `EVIDENCE_PER_GAP = 6` notes × `EVIDENCE_TEXT_CHARS = 600`, plus up to
6 money lines, plus `QUESTION_SHOWN_CHARS = 1450` for the echoed question.

**Every existing mechanism by which code tells the planner that something exists and is pullable:**

1. **`historyLine`** (`src/teamLead/planner.ts:647`) — the canonical example, and its header states
   the doctrine outright: *"injecting a growing history into every prompt does not scale … But 'you
   have decided about this before, and here is the last thing you did' has to be present whether or
   not the model thinks to ask — the failure it prevents … IS the failure of not knowing there was
   anything to look up. **Push the keys and the existence; pull the content.**"* It renders
   `watched since <label> — considered N×, last: <action> Nh ago. Use recall_decisions for the
   detail.` — and names the tool explicitly.
2. **The orphan footer** (`src/teamLead/memory.ts:190-194`) — `not in your index: a.md, b.md (+3
   more)`. Verified working on a live tick: the model followed it and called
   `read_memory {"path":"stray-note.md"}` unprompted.
3. **The `THE RECORD` line** (`planner.ts:838-844`) — states a code-computed fact and what it
   authorises, rather than leaving the planner to query for it.
4. **The `dates you may use` block** (`planner.ts:857-865`) — serves the values directly rather than
   naming a lookup.
5. **The `money on this job` block** (`planner.ts:920-927`) — pushes up to 6 rows plus a sentence
   saying how to weigh them.
6. **`spine_read`'s description** (`src/mcp/server.ts:1695+`) — carries `SPINE_VIEW_CATALOG`, which
   is how the planner learns which views exist at all.

The counter-example is `gap_summaries`: written every tick, named nowhere in the prompt, reachable
by no tool, read by nothing.

## External Dependencies

None specific to this area. Storage is Supabase/PostgREST; the model call is provider-agnostic
through `src/model/toolLoop.ts` (currently OpenRouter → `z-ai/glm-5.3` in the pilot).

## Constraints and Invariants

1. **`src/db/` is an import leaf.** No production module under it imports from `src/jobs/`,
   `src/teamLead/` or `src/control/`. Rails and rendering live above it — the reason
   `src/teamLead/memory.ts` and `src/db/plannerMemory.ts` are separate files.
2. **The team-lead dispatch gate is deny-by-default.** A tool must appear in **both**
   `TEAM_LEAD_TOOL_NAMES` (`src/teamLead/identity.ts:37`) and `TEAM_LEAD_TOOLS`
   (`src/mcp/server.ts:1695`). The allowlist gates dispatch; the array supplies the schema the loop
   is handed and derives `TEAM_LEAD_ONLY_TOOL_NAMES`, which refuses those names to every non-`spine:`
   badge. The gate's error is `'the team-lead identity is capped to reading, asking and its own
   notes — tool not allowed'` (`server.ts:2430`). A test pins the two lists paired
   (`server.test.ts:8218`), with `get_customer_context` and `resolve_date` listed as known-unreachable
   drift.
3. **The stated rule the gate enforces:** *"There is no human behind this identity to confirm
   anything, so nothing irreversible or externally visible may ever dispatch for it; enforcement is
   mechanism (the gate), never prompt text"* (`identity.ts:9-14`). `write_memory` is recorded as
   passing it because every overwrite is versioned and no person receives anything — and as being
   novel in one way: *"the first model call that mutates durable state from INSIDE the tool loop,
   with no post-loop validation stage"* (`identity.ts:25-29`).
4. **The L1 capture obligation, verbatim** (`CLAUDE.md`): *"outbound/agent-action captures are
   classifier-free — every send via the spine `send_email` tool and every state-changing Composio
   execution ingested by `src/composio/logIngest.ts` is captured with NO work/personal gate. An
   outbound action is something the agent performed on the business's behalf … Consequences: (a)
   disclosure obligation … (b) non-send captures store argument KEY NAMES only, never values
   (keys-only redaction — L1 is undeletable)."* The keys-only rule is implemented at
   `src/composio/logIngest.ts:261-262`. `send_email` captures through `appendRawCapture`
   (`src/mcp/server.ts:3293`, `:3436`, `:3829`).
5. **Memory writes were ruled OUT of that obligation** — build 3 plan, Decisions: *"Memory writes are
   not captured to L1 — user. They match neither clause of the 2026-07-04 outbound rule. The
   `cost_events` row every tool call already writes is the only trace."* That `cost_events` row is
   emitted before the tier gate (`server.ts` dispatch preamble) with `sku: 'tool_call'` and
   `metadata: { tool: name }` — it records **which tool** was called, not the path or the content.
6. **`nudge_decisions` is append-only and view-less**, both for stated reasons (§4).
7. **`nudges.context` is watcher-written JSON**, not a typed column. `v_nudges` and `v_review_items`
   both guard the `jobId` extraction with a case-insensitive UUID regex before casting, because a
   bare `::uuid` over a malformed value would throw for the whole query.
8. **PostgREST caps rows at 1000** (`supabase/config.toml:18`), which is why `countSummaries` is a
   count rather than a page.
9. **`get_job` returns `attributes` to every badge**, technicians included (§2).

## Decision Points

**(a) Own table vs `jobs.attributes`.**
`jobs.attributes` is the spine's designated elastic layer and needs no index — the job id addresses
it. Using it means: the value must either adopt `StandingFactBundle`'s exact three-key shape (whose
`value` is a **scalar**, so prose does not fit) or sit beside bundles as a differently-shaped entry in
the same JSONB, which `isFactBundle` tolerates but which puts two kinds of thing in one bag; the
content is returned by `get_job` to every badge; and there is a recorded 2026-08-19/20 decision
against exactly this, on the grounds that *"`get_job` renders L3 to managers as fact, and a model's
deliberations are the weakest evidence class there is"* — a plan choosing this would be overturning
that and should say so. An own table means: no view exposes it unless one is written, the FK decides
lifecycle (a `job_id` FK cascades on job delete; `nudge_decisions` deliberately has **no** job FK so
as not to be constrained by the job lifecycle), and RLS/revoke must be added explicitly because
`auto_expose_new_tables = true` is still set.

**(b) Reuse `read_memory`/`write_memory` with a reserved path space, vs its own verb pair.**
Reuse means no new tool schemas (the loop's cacheable prefix does not grow) and one mental model for
the planner. It also means `renderMemoryIndex` would have to exclude the reserved prefix from both
the orphan scan (`memory.ts:186`) and the `listMemoryPaths` read, or every per-job file would be
counted an orphan, the footer would fill with job paths, and the `+N more` tail would drown the
signal it exists for. Separate verbs mean two more schemas in the prefix and a second write verb to
justify against the gate's stated rule, but leave the memory index untouched and allow addressing by
`(subject_type, subject_id)` rather than by a synthesised path string.

**(c) The write cadence, given §3.**
A job reaches `buildGapView` only while it carries an open registry-known gap. So a notepad written
by the planner can only be created or updated during that window. "As the job evolves" is, today,
"while a gap is open on it" — a job with no gaps is never in front of the planner, and no code path
exists that would put it there. Changing that is the subject of builds 6 and 7 in the harness rebuild
order (`docs/engineering-memory.md:3380-3392`), which are not yet built.

**(d) Whether `gap_summaries` becomes the feedstock or follows the Reflector out.**
It is currently written every lifecycle tick and read by nothing in production (§4). It already
carries `job_id`, `subject`, `resolution`, `arc`, `considered` and `manager_fate` per closed gap. The
options its current state creates: give it a reader (a view, or a per-job read surfaced to the
planner), fold its content into whatever a notepad becomes, or drop the table and the sweep as the
Reflector was dropped. Doing none of those leaves a write path with no consumer.

**(e) Planner-private vs manager-visible.**
The catalog `spine_read` reads is **shared with the manager's `query_spine`** — the same
`SPINE_VIEW_CATALOG` string, the same views. So exposing a notepad through a `v_*` view makes it
manager-readable by construction. `nudge_decisions` was kept view-less for precisely this reason
(:70-73), and `recall_decisions` exists as a team-lead-only tool instead — the recorded rationale
being that the planner's deliberations *"are not a manager's business."* A notepad reached through
`jobs.attributes` would additionally be visible to **technicians** via `get_job`. A notepad reached
through a team-lead-only tool would be planner-private on the same pattern as `recall_decisions`.

## Open Questions

1. **Does anything downstream depend on `gap_summaries` continuing to be written?** No production
   reader exists in this repo, but the table is on the pilot and the metrics views were checked only
   for *dependency* (none) — not for whether an operator queries it by hand.
2. **What does `jobs.attributes` actually contain on the pilot today?** The shape is known; the
   volume and key names are not, and that bears on whether a prose entry beside bundles would be
   noticed by `get_job`'s consumers. Answerable with a read-only query.
3. **Would a per-job notepad need retraction folding?** Standing facts disappear when their evidencing
   capture is retracted. A planner-written summary that quotes a note whose capture is later retracted
   has no equivalent mechanism, and whether one is wanted is not answerable from the code.
4. **How often does a job carry more than one gap over its lifetime?** This decides whether a notepad
   is written once and re-read, or genuinely accumulates across gap windows. Measurable from
   `nudge_decisions` grouped by `job_id` on the pilot.
