---
date: 2026-08-19
task: Replace the ladder's per-gap sentence-writer with a team-lead planner — one agentic call per firm per half-hour that owns pacing, closure and escalation
research: thoughts/shared/research/2026-08-19-team-lead-planner-call.md
status: draft
---

## Overview

The team lead currently makes one model call per gap that writes a sentence; every other decision
is a constant. This plan makes it a **planner**: one call per firm every 30 minutes that sees all
open gaps, can read the spine, and decides when to ask, when to escalate, and whether a gap was
answered. Code keeps the guarantees — ask window, delivery deadline, orphan doctrine, dedup,
runaway brakes — and the planner works inside them.

**Explicitly out of scope:** batching (needs the carrier/rider schema and transport changes; the
planner architecture must land first) and the capture-time funnel (separate research).

## Decisions

- **Planner cadence: every 30 minutes** (user) — `getUTCMinutes() % 30 < 5`, the stateless
  `heavyTick` pattern at `lifecycle.ts:130`. ~24 calls/tenant/day inside the 7am–7pm ask window.
- **The planner gets read tools** (user) — it must traverse the spine for context.
- **A dedicated team-lead reader, not a gate exemption** (user) — `query_spine` is on the
  team-lead allowlist but dies at the manager gate (`server.ts:1925`), traced and probed. A third
  `TEAM_LEAD_TOOLS` list sidesteps the manager boundary instead of weakening it.
- **The planner decides closure and escalation** (user), tuned by prompt engineering. Not
  answered → escalate; answered → close; still unanswered after escalation → close.
- **Deadlines become data, constants become defaults** — `not_before` / `escalate_after` on
  `nudges`. If the planner never runs, every row still escalates on its default. Fail-safe.
- **Facts stay in code** — "did anything land on this job", "was this never delivered in 24h",
  dedup, reachability. The planner adjudicates; it does not go hunting for facts code owns.
- **Cite-or-don't-close** — to mark a gap answered the planner must quote the evidence. The
  `assert-only-cited` doctrine from money inference, reused. Ambiguity defaults to open: a
  false-open is loud and cheap, a false-close is quiet.
- **Evidence is bounded in code, not by the model** — the planner sees only what landed after
  `asked_at`, plus the `nudge-<id>` session attribution the transport already produces.
- **Shadow first** — Phase 3 plans and writes nothing. This is how the token cost gets measured
  before anything depends on it. Matches the watcher's own shadow-first rollout.
- **The planner owns TIMING and CLOSURE only; compose still writes the sentence** (self-review
  fix). Moving message-writing into the planner is a batching concern — it needs one central
  prompt with per-spec guidance strings — and pulling it in here would double this plan and put
  the code-owned frame (bare date, no weekday; served time phrase; footer) at risk for no gain.
  Deferred with batching.

## Plain-language walkthrough

**Phase 1 — teach the spine to hold a conversation with a model.** Every model call the spine
makes today is one-shot: one question, one answer, done. A planner needs to look things up
mid-thought. This phase adds that loop and gives the team lead one read tool of its own. Nothing
about nudges changes; you'd notice it working because a test can ask the team lead a question that
requires looking something up, and get a right answer.

**Phase 2 — move the deadlines onto the rows.** Today "escalate after 48 hours" is a constant that
applies to everything. This phase gives each nudge its own `escalate_after` and `not_before`
columns, with the old constants as defaults, so behaviour is *identical* until something writes
them. Also fixes a gap this design forces: cost items currently never leave the manager's queue.

```
   before          every row: 48h, from a constant
   after           every row: its own deadline, defaulting to 48h
```

**Phase 3 — the planner runs, but only watches.** Every 30 minutes it looks at the firm's open
gaps, reads whatever context it wants, and produces a plan — which to send, which to hold, which
look answered. It writes **nothing**. The plan is logged. This is where we learn what it costs and
whether its judgment is sane, at zero risk.

**Phase 4 — the planner takes the wheel.** The same call now writes its decisions onto the rows.
Code still enforces every rail.

```
  watcher ─▶ pending ─▶ [PLANNER every 30 min] ─▶ deadlines on rows
                              │                          │
                              │                     sweep enforces (5 min)
                              ▼                          ▼
                        adjudicates asked rows       send / escalate / close
```

## Secrets & env preflight

- **Phase 1:** none new. `MODEL_PROVIDER` + the active provider's key are `already required`.
- **Phase 2:** none.
- **Phase 3:** `PLANNER_MODE` in the Render cron env — `off` (default) | `shadow` | `live`.
  Set to `shadow` for this phase. New; the user sets it in the Render dashboard.
- **Phase 4:** same key, flipped to `live`.

---

## Phase 1: The agentic loop and the team-lead reader

### What this phase does
Adds the spine's first multi-turn model call and a read tool the team-lead identity can actually
reach. No ladder behaviour changes.

### Changes required

**`src/model/toolLoop.ts`** (new)
- `runToolLoop(req, tools, execute, ctx)` — multi-turn beside `runForcedTool`, not replacing it.
- Hard caps: `MAX_TURNS = 8`, wall-clock budget, and `recordModelUsage` per turn (today it fires
  once inside `runForcedTool` at `forcedTool.ts:350`).
- Terminates on a final assistant message with no tool call, or on cap. Cap-exhaustion throws.

**`src/mcp/server.ts`**
- Export a narrow in-process entry: `dispatchForIdentity(name, args, identity)` wrapping the
  module-private `dispatch` (`:1864`). Do **not** export `dispatch` itself.
- Add `const TEAM_LEAD_TOOLS = [...]` with ONE entry, `spine_read`, and a description written for
  a planner (not a manager answering ad-hoc questions). It must NOT be in `ADMIN_TOOLS`, so
  `ADMIN_TOOL_NAMES` (`:1584`) never contains it and the manager gate at `:1925` cannot fire.
- Dispatch: make it a FALL-THROUGH — `case 'query_spine': case 'spine_read': {` at `:4868`.
  The body already delegates to `runSpineQuery`, which runs as the `spine_reader` role (SELECT
  on the views, no write privilege), so both names share one implementation and the DB-level
  read-only guarantee by construction. Do NOT copy the handler.

**`src/teamLead/identity.ts`**
- `TEAM_LEAD_TOOL_NAMES`: add `'spine_read'`. Leave `query_spine` in place or remove it —
  removing is preferred, since it is provably unreachable and a dead allowlist entry is a lie.

### Automated verification
- [x] `npx tsc --noEmit`, `npm run lint`, `npm test` pass — 91 files, 1843/1843
- [x] new test: `spine_read` dispatches for `spine:team-lead` and returns rows
- [x] new test: `spine_read` is NOT in `ADMIN_TOOL_NAMES` (guards the whole design) —
      asserted behaviourally (it answers for a roster-less identity), plus a disjointness
      test in `src/eval/toolCases.test.ts`
- [x] new test: a write tool still hits the cap error for `spine:team-lead` (pre-existing,
      still passing) — and the NEW inverse gate: `spine_read` is refused to managers and
      technicians, so the surface shifted rather than expanding
- [x] new test: `runToolLoop` stops at `MAX_TURNS` and records usage per turn
- [x] mutation check: three mutations, each caught — (a) removing the `spine_read` case,
      (b) adding `spine_read` to `ADMIN_TOOL_NAMES`, (c) disabling the inverse gate

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; a provider key in `.env` for a real loop call
- [x] run a loop asking a question that needs a lookup ("how many jobs completed this week")
      and confirm it made ≥1 tool call and returned a number matching a direct SQL read

  **Evidence (2026-08-19, local stack `http://127.0.0.1:54621`, GLM-5.2 via Fireworks):**
  2 turns, 1 tool call, 998ms wall. The model wrote its own SQL —
  `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'completed') AS completed FROM v_jobs`
  — and answered `total=3 completed=0`. Independent psql read of the base table
  (`select count(*) … from jobs where tenant_id = $1`) returned `{"total":3,"completed":0}`:
  match. Cross-channel read-back from `query_audit` confirms the query executed under
  `technician_ref = 'spine:team-lead'`, row_count 1, no error. Wall time across three runs:
  998ms / 2496ms / 13334ms for 2 turns — **provider variance is large**, and 13.3s for two
  turns puts eight turns near the 90s ceiling. Re-check against Phase 3's shadow latencies.

**Beyond the plan (implementer, flagged):** an INVERSE gate was added at `server.ts:2042` —
keeping `spine_read` out of `ADMIN_TOOLS` dodges the manager gate but would also have left it
open to every technician badge, since `ADMIN_TOOL_NAMES` is the only tier gate. The surface
shifts rather than expands. Two files outside the plan's list also changed:
`src/model/forcedTool.ts` (endpoint resolvers extracted so the two transports cannot drift) and
`src/eval/toolCases.test.ts` (its tool-surface scraper swept up the new list).

**Adversarial review: 2 rounds.** Round 1 found 7 issues, all folded: unbounded ERROR results,
unbounded tool calls per turn, a budget that could not bound a hung request, ceilings that were
only defaults, an unpinned `spine_read` description, mismatched synthesized tool-call ids, and
zero Anthropic-transport coverage. Round 2 verified each fix by breaking it, and found two more:
an abort escaped without the caller's label, and nothing asserted the outbound `tools` array
(the quiet failure — the API answers in prose and the loop returns it as a plan). Both closed
and mutation-checked. Round-2 note carried forward: **use `safeEnvInt`, never `Number()`, for
Phase 3's env plumbing** — `Math.min(NaN, 8)` is `NaN` and `turns >= NaN` is false, which would
disable the turn ceiling entirely.

### Manual verification
- [ ] none

---

## Phase 2: Deadlines as data, and a queue that drains

### What this phase does
Moves escalation timing from a constant onto the row, with the constant as the default, and fixes
the cost-item auto-resolve gap that escalate-then-close depends on. Behaviour is unchanged.

### Changes required

**`supabase/migrations/20260820120000_nudge_deadlines.sql`** (new)
- `alter table nudges add column not_before timestamptz, add column escalate_after timestamptz;`
- Nullable on purpose: null means "use the default", so every existing row keeps today's rules.
- Comment both columns with who writes them and what null means.

**`src/db/nudges.ts`**
- `setNudgeSchedule(id, tenantId, { notBefore, escalateAfter })` — status-guarded conditional
  UPDATE, the `markNudgeQueued` shape (`nudges.ts:98`), returns null when the row moved.

**`src/jobs/watchers.ts`**
- Escalation check (`:503-507`) reads `n.escalate_after ?? asked_at + NUDGE_ESCALATE_HOURS`.
- The open-item sweep at `:287` currently reads `findOpenGaps(tenantId, 'overdue_visit_gap')`
  only. Read **every registered kind** so cost items can auto-resolve. Their resolve predicates
  already exist on the specs.

**`supabase/migrations/20260820120001_review_items_ever_index.sql`** — **NOT WRITTEN: already
exists.** `20260819130000_job_cost_gap_backstop.sql` landed with the cost detector and creates
`uq_review_items_job_cost_gap_ever` on exactly these columns. Confirmed present on both the local
stack and the pilot; a duplicate migration would fail on the second apply. The duplicate-row
precondition was checked anyway and is clean (0 dupes for both kinds).

**Divergence from the plan, and one it understated:**
- The deadlines migration is dated `20260819150000_nudge_deadlines.sql`, not `20260820…` — a
  migration stamped tomorrow reads as a mistake forever, and the prefix is only an ordering key.
- The plan said cost items could auto-resolve because "their resolve predicates already exist on
  the specs". They did not: `filled`/`moot` are typed on a `Nudge` and answer the TECHNICIAN's
  question, while the item sweep works on `ReviewItem` rows and asks the MANAGER's. So the
  registry gained a third predicate, `itemResolved`, plus `subjectIsVisit` (a job-scoped kind's
  `subject_ref` must not be looked up in `assignments`) and a `jobsWithCostEvents` fact.

**`src/teamLead/compose.ts`**
- The pending filter (`:177`) additionally skips rows whose `not_before` is in the future.

### Automated verification
- [x] `npx tsc --noEmit`, `npm run lint`, `npm test` pass — 91 files, 1871/1871; `npm run build` too
- [x] new test: a row with `escalate_after` in the past escalates; null falls back to 48h — plus
      a stamp in the FUTURE holding past 48h, a malformed stamp falling back, and a stamp on a
      never-asked row not escalating (the delivery deadline owns that row)
- [x] new test: a row with `not_before` in the future is not composed, and IS composed after —
      plus: it costs no model call and no write, a malformed hold fails OPEN, and a held row does
      not block its neighbours
- [x] new test: an open `job_cost_gap` review item auto-resolves when its job gains a cost — plus
      it STAYS open on activity alone, closes on a cancelled job, and its job-id subject never
      reaches the assignments lookup
- [x] existing watcher/compose suites pass unchanged; the two visit-item resolutions are asserted
      byte-identical to the pre-registry wording
- [x] mutation check: four, each caught — escalation ignoring `escalate_after`; the item sweep
      reading one hardcoded kind; job-scoped subjects leaking into the assignments lookup;
      compose ignoring `not_before`

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (pilot is READ-ONLY here — read-backs only)
- [x] applied to the local stack via `supabase db reset`; both columns exist, are `timestamptz`,
      and are nullable with no default (confirmed by an `information_schema` read)

  **Pilot read-back (SELECT only, 2026-08-19):** 6 nudge rows / 1 open (the escalation specimen —
  its `escalate_after` will be NULL, so it still fires on the 48h constant as designed); 50 open
  `overdue_visit_gap` items, 0 open `job_cost_gap` items; **zero** duplicate `(tenant, subject_ref)`
  pairs for either kind, so the plan's "check for duplicates first" precondition holds. Both
  `uq_review_items_*_ever` indexes ALREADY EXIST on the pilot — see the divergence note below.

**Adversarial review (1 round, 5 findings, all folded):**
1. `setNudgeSchedule` cleared a column when handed an explicit `undefined` — and that is exactly
   the Phase-4 call shape, since `PlannerDecision`'s fields are optional and the natural call site
   spreads both keys. "No opinion about escalation this tick" would have erased last tick's
   deadline. Keyed on `!== undefined` now, not `in`; pinned and mutation-checked.
2. The migration comment promised a clamp that does not exist until Phase 4. Reworded to say what
   is true and who owes the clamp — a column comment is the one doc a future engineer reads at the
   database.
3. **Behaviour-identity has exactly one intended exception**, now pinned by its own test: an
   `overdue_visit_gap` ITEM whose detail lacks a parseable `startsAtLocal` used to be dropped by
   the parse and could never auto-resolve at all; it now closes on the status path with wording
   that already existed. Strictly better, and empty for rows written by current code. An item with
   no `jobId` is still dropped — that half of the parse stays fail-closed.
4. Only the ITEM half of the `subjectIsVisit` guard was pinned; the NUDGE half now has its own
   test (mutation-verified).
5. `listJobsWithCustomerByIds` was a single unbounded query, and this phase changed its input from
   "open nudges" to "open nudges + every open review item" — a set that grows with the manager's
   backlog, not with the day. Chunked and paged like every other batched reader on this path, with
   a stable `order` so paging is correct. `listJobIdsWithCostEvents` gained the same chunking on
   its INCOMING jobIds (it already chunked `costIds`).

### Manual verification
- [ ] none

---

## Phase 3: The planner, in shadow

### What this phase does
Runs the planner every 30 minutes, produces a plan, writes nothing. Measures cost and judgment.

### Changes required

**Divergences from the plan, all flagged:**
- **`src/model/toolLoop.ts` gained `terminalTool`** (a Phase-1 file, touched here because Phase 3
  is its first consumer). Without it the planner would have to spend a whole extra billed
  round-trip hearing the model say "done" after it had already submitted — and would lose the
  entire plan to the turn ceiling whenever the model did not bother to say it.
- **The `nudge-<id>` session attribution is NOT available.** The plan says the transport "already
  produces" it: it produces the *session* (`nudgeQueue.ts:105`), but nothing carries that id onto
  a capture, so the spine cannot tell a reply-to-a-nudge from any other note. Evidence is bounded
  by time and job only. Stamping it would be a capture-side change, separate from this plan.
- **The executor takes `tenantId` as a parameter**, not as a closure the caller binds once — the
  planner walks every tenant in one process, and an executor bound to the wrong one would read
  another firm's records into this firm's prompt.

**`src/db/rawCaptures.ts`** (not in the plan's list) — `listJobEvidenceSince`, the text twin of
`listJobStampedCaptureTimes`. Needed because a citation requires the WORDS, and because it must
union the same two homes the activity probe does: a technician's reply lands in L1 before identity
is resolved, so it often carries no `job_id` and is reachable only through the visit minted from
it. Drops `manager_only` rows and folds retractions — citing a retracted note would be worse than
citing nothing.

**`src/teamLead/planner.ts`** (new)
- `runPlanner(nowIso, mode, deps)` — per tenant with a live Telegram binding:
  - gather open nudges (`listNudgesByStatus`, `OPEN_NUDGE_STATUSES` at `nudges.ts:23`)
  - build a per-gap projection: kind, subject, technician, ages, and for `asked` rows the
    evidence that landed **after `asked_at`** (bounded in code) plus whether it arrived through
    the `nudge-<id>` session
  - one `runToolLoop` call with `spine_read` available
  - returns `PlannerDecision[]`: `{ nudgeId, action: 'send'|'hold'|'close'|'escalate',
    notBefore?, escalateAfter?, citation?, confidence, reason }`
- Ask-window gated: skip the call entirely outside 7am–7pm (no point planning what cannot send).

**`src/teamLead/plannerPrompt.ts`** (new)
- System prompt + tool schema. Must encode: cite-or-don't-close; ambiguity defaults to open;
  a gap is answered only by evidence that answers *the question asked*, not by any activity.

**`src/jobs/lifecycle.ts`**
- New step gated on `getUTCMinutes() % 30 < 5` and `PLANNER_MODE`, running **before**
  `runTeamLeadCompose` (`:342`). In shadow it only logs its summary into the tick output.

### Automated verification
- [x] `npx tsc --noEmit`, `npm run lint`, `npm test` pass — 92 files, 1906/1906; `npm run build` too
- [x] new test: shadow mode writes NOTHING — **against the real database**, not a stub. The
      stub version would have been vacuous (this phase gives the planner no writer at all): the
      test plants a real nudge, runs a real shadow pass returning a `hold`, and asserts the row is
      byte-identical afterwards, `updated_at` included
- [x] new test: the evidence projection excludes anything at or before `asked_at` — plus: another
      job's evidence is never borrowed, a never-asked gap is shown none, and the per-gap cap keeps
      the newest
- [x] new test: a decision without a citation cannot produce `close` — plus **assert-only-cited**:
      a citation that does not appear in what the model was actually SHOWN is refused too, while
      differing whitespace and case still pass (quoting, not rewording)
- [x] new test: outside the ask window the model dep is never invoked — and the window is the
      FIRM's, not UTC
- [x] new test: the 30-minute gate — `:00`/`:30` run, `:10`/`:40` skip. **The first version of this
      table passed against `% 15` too**; `:15` and `:45` are the only minutes that separate the two
      cadences, and the mutation check is what caught it
- [x] further rails pinned: unknown gap, duplicate decision, unknown action, hold without a usable
      `notBefore`, unreadable confidence reading as LOW, a submit that never arrives, and junk in
      place of the decisions array (which found a real crash on `[null]`)
- [x] mutation check: four, each caught — the evidence bound at `>=`; the citation-in-evidence
      check disabled; the ask-window skip removed; the cadence changed to 15 minutes

### Live verification (agent-executable)
- Prerequisites: `render` MCP (workspace `tea-d69903h5pdvs738dm81g`); `supabase-test` MCP for
  read-backs; `PLANNER_MODE=shadow` set on the cron
- [x] **run locally against the real model and the real dispatch first** — this was not in the
      plan and it is what caught two defects a deployed run would have discovered slowly:
  1. **The first run produced NO plan at all.** GLM-5.2 thinks by default, and at `maxTokens:
     4096` the very first turn came back `finish_reason=length`. The truncation guard did its job;
     the planner simply could not function. Fixed by bounding the think (`reasoningEffort: 'low'`
     — deliberately NOT `'none'`, which is right for a forced-JSON extraction and wrong for the
     one call whose entire job is judgment) and raising the budget to 8192.
  2. **It reasoned "it is the middle of the night" at 18:50 firm-local**, because the prompt
     handed it UTC and nothing else — while pacing is precisely a judgment about whether this is a
     decent hour to bother someone. The prompt is now grounded in the firm's own clock, weekday and
     date from one derivation, zone named. Pinned by a test.

  **Result after both fixes** (local stack, GLM-5.2 via Fireworks, two planted gaps — one answered
  by a technician note, one silent):
  - the ANSWERED gap → `close`, high confidence, citing the note **verbatim**; the code-side
    citation check accepted it
  - the SILENT gap → `hold`, medium, reasoning that it had used `spine_read` to discover *the job
    is assigned to a different technician* — judgment no constant could express, and the reason
    the read tool exists
  - 0 refused, 0 errors, and the `nudges` rows **byte-identical before and after**
- [x] **measured cost per call** — the number the cost question has been waiting on:
      2 gaps → 2 turns / 2 tool calls / **10.6s**, and 3 turns / 4 tool calls / **28.6s** on the
      run where it went looking. At 30-minute cadence inside a 12h window that is ~24 calls per
      firm per day. **Flag for Phase 4:** 28.6s against a 90s `MAX_TOOL_LOOP_BUDGET_MS` is not
      comfortable headroom once a firm has twenty gaps rather than two — re-check before going
      live, and log a budget throw distinctly from a model error.
- [ ] after deploy, read cron logs for ≥3 planner ticks and confirm the same on the pilot
      **(blocked: needs `PLANNER_MODE=shadow` on the Render cron — user action)**

  *Wording note for the next reader:* shadow leaves **`nudges` byte-identical**, which is the
  claim. It does still write telemetry — one `cost_events` batch per model turn, one per tool
  call, and one `query_audit` row per `spine_read`. That is the phase's own goal ("record the
  measured cost per call") and the read audit trail, not a regression.

**Adversarial review (1 round, 7 findings + 1 minor, all folded):**
1. **`listJobEvidenceSince` had ZERO automated coverage** — the function that decides what a
   citation may be checked against, crossing a tenant boundary on a join, with Phase 4 about to
   turn its output into a row-closing write. New suite `src/db/rawCaptures.test.ts`, 9 tests,
   4 mutation-verified. Writing it surfaced a guard nothing exercised: `visits.source_capture_id`
   is a bare FK with no tenant constraint, so a visit in OUR tenant can name ANOTHER tenant's
   capture — and the visit query that finds it is filtered by our tenant, so nothing upstream
   catches it. The capture fetch's own `tenant_id` filter is the only thing stopping that from
   becoming citable evidence, and it is now the subject of its own test.
2. **The citation rail accepted a trivial quote.** `citation: 'the'` against *"the van broke down,
   nothing to report on this job yet"* was ACCEPTED — and in Phase 4 that closes a real gap and
   writes `"the"` into `resolution` as the evidence. Now requires ≥2 words and ≥12 characters,
   which keeps genuinely short answers ("forty dollars") and rejects the merely-present ones.
3. **Two gaps on one job share one evidence pool**, so a `job_cost_gap` could be closed by quoting
   *"visit went fine"* — the exact hole the missing `nudge-<id>` attribution would have filled.
   Two partial rails, both honest about what they do NOT fix: **one quote may close only one gap
   per plan** (stops one note closing every gap on a job, which is the shape that would actually
   happen), and the prompt now SAYS when a job carries more than one open gap, because code knows
   that and the model would have to infer it. A single wrong close is still possible; the real fix
   is a capture-side session stamp.
4. **`hold` had no bounds** — `notBefore: '2099-01-01'` passed. Now refused if in the past
   (it holds nothing) or past `created_at + 24h`, beyond which the expiry sweep hands the gap to
   the manager as *never delivered* — the opposite of a hold. This is the clamp `not_before`'s
   column comment names, landed early because the shadow log is the human judgment gate and
   "hold until 2099" must not read there as a valid decision.
5. Telemetry-vs-state wording — folded into the note above.
6. Tenant isolation confirmed sound, no change.
7. **A wholly-refused plan was silently lost.** Validation ran after the loop, so the model never
   learned its citation was unusable and the gap just stayed open. `validateDecisions` now runs
   INSIDE the executor: a submission where every decision is refused comes back as a tool error
   naming the reasons, and the model corrects it within the turn ceiling. An empty plan is still
   accepted as a legitimate choice. (This also made the test's loop stub unfaithful — it let the
   throw escape, which the real loop never does. Fixed.)
8. The planner is deliberately **not** gated on `NUDGES_MODE`: it follows the sweep's
   rollback-rescue doctrine (in-flight rows keep their lifecycle) rather than compose's creation
   gate. Documented at the gate.

**Human gate outcome (2026-08-20) — user judged the plans, two changes requested and made:**

The judgment on ordinary gaps was accepted, specifically the two holds on the technician who
promised a write-up rather than answering. Three consecutive ticks over six gaps: the
acknowledgement-not-an-answer note never closed a gap; 50h of silence escalated every tick while
1h of silence did not; and a held gap closed the tick after its answer landed, quoting it.

Two defects the gate exposed, both now fixed:

1. **A gap is a HOLE IN THE RECORD, not an unanswered message.** Probed live: a cost gap whose
   figure the MANAGER had already entered ($127.50 on the money ledger) was HELD, not closed. The
   planner ran six queries, found the ledger row, said so in its reasoning — and chased the
   technician anyway. Two causes: the prompt framed closing as *"it has been answered"* (a
   conversation), and the citation rail only accepted quotes from technician notes, so closing on
   the ledger was **impossible even if it had wanted to**. We gave it read tools and made what it
   reads inadmissible.
   **Fix:** a second closure basis. `basis: 'record'` closes a gap because the hole is filled,
   whoever filled it — authorised ONLY by a code-computed fact (`listJobIdsWithCostEvents`, the
   same reader the item sweep uses), never by the model asserting it; the resolution text is
   code's words. `basis: 'evidence'` is the existing quote-the-answer path, unchanged. The gap
   block now states what the record says, both ways. **41.1s and a wrong hold → 1.3s and a correct
   close, with no reads needed at all.**
   *Scope note:* this gives the PLANNER a record-basis close. The sweep's `filled` predicate still
   ignores the ledger — the three "ladder cannot see the money ledger" defects are still to be
   designed together.
2. **It hunted by name because we withheld the ids.** The gap block named the job and customer in
   words but not their ids, so it searched `customer_name LIKE '%Okafor%'` and burned turns on
   queries returning nothing. The block now carries the job id and says to filter by it.
   **10 name searches → 0; empty results 12 → 5; turns per tick 3/7/8 → 2/1/3.**

Re-verified after both: the endorsed judgment is unchanged — the promise still never closes a gap,
the silent gap still escalates, the answered gap still closes on a verbatim quote, and shadow still
leaves `nudges` byte-identical.

**Out-of-plan fix (a red gate blocked the commit):** `src/control/weekdayGuardPlugin.test.ts` began
failing when the clock rolled to 2026-08-20 — nothing to do with this plan. `expandOrdinals`
resolves a bare "the 4th" to whichever month's 4th is NEAREST TODAY, so from the 20th of a month it
means next month's, landing on a different weekday. Both hook tests hardcoded "Aug 4 is a Tuesday";
they cannot pass a reference date because the handler reads the real clock. Both now state the date
in full (month + year), which removes the resolution entirely. One had detonated; the other was
surviving on luck.

**Follow-up the reviewer surfaced, OUT of scope here:** three other callers leave GLM-5.2's
default thinking on against small budgets — `src/calls/classifyCall.ts` (maxTokens **256**),
`src/email/classify.ts` (**256**), `src/writePath/extract.ts` (1024). That is precisely the shape
that produced `finish_reason=length` on the planner's first turn. They work today because their
prompts are short; a long email or transcript is the input that would trip them. Worth its own
measurement.

### Manual verification
- [ ] read three consecutive shadow plans and judge whether the hold/close/escalate calls are
      ones you would have made. This is the judgment gate — nothing automated can stand in for it.

---
*Pause after this phase — its manual check is the go/no-go for Phase 4.*

## Phase 4: The planner takes the wheel

### What this phase does
The same call now writes its decisions. Code still enforces every rail.

### Changes required

**`src/teamLead/planner.ts`**
- In `live`, apply decisions: `setNudgeSchedule` for `send`/`hold`; `markNudgeOutcome('answered')`
  for `close` (citation required).
- **`escalate` writes `escalate_after = now` and lets the SWEEP escalate** (self-review fix).
  Escalating directly would be a second escalation path re-implementing the rung-2 flag and the
  orphan doctrine beside the one at `watchers.ts:579-616`. One path, reached two ways.
- **Rails, all code-side, applied to every decision before it lands:**
  - `escalate` and `close` go through the existing handoff/resolve helpers — the orphan doctrine
    is not re-implemented
  - `notBefore` is clamped so it can never push a row past its 24h delivery deadline
  - a decision naming an unknown or already-terminal `nudgeId` is dropped and logged
  - a whole-call failure leaves every row untouched — the sweep's constants still apply

**`src/jobs/lifecycle.ts`**
- `PLANNER_MODE=live` applies decisions; the summary gains per-action counts.

### Automated verification
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test` pass
- [ ] new test: `close` without a citation is refused in code even if the model returns one
- [ ] new test: `notBefore` beyond the 24h deadline is clamped, not honoured
- [ ] new test: a decision for an already-`answered` row is dropped, not applied
- [ ] new test: a thrown planner call leaves all rows unchanged and the sweep still escalates on
      defaults
- [ ] mutation check: disabling the clamp makes its test fail

### Live verification (agent-executable)
- Prerequisites: `render` + `supabase-test` MCP; `PLANNER_MODE=live`; a staged gap on the pilot
- [ ] one gap is held then sent, and `nudges.not_before` shows the planner's stamp
- [ ] one asked gap is closed with a citation; read back `resolution` and confirm it quotes real
      evidence that exists in `raw_captures`/`visits`
- [ ] judge by the session **trajectory**, never CLI stdout (Stage 1's rotting-stdout trap)

### Manual verification
- [ ] confirm a real message still reads like a colleague — the frame is code-owned but the
      sentence is now written in a different call
