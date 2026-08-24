---
date: 2026-08-23
task: ⑤ memory architecture — baseline metrics, gap-life summaries, a lessons store, and a shadow Reflector
research: thoughts/shared/research/2026-08-23-memory-architecture-substrate.md
status: draft
supersedes: nothing
---

## Overview

Give the planner a memory that improves it: record each gap's whole story as one code-written
summary, distill summaries into a small per-firm list of falsifiable lessons, inject those
lessons into future planner ticks, and measure — with a baseline captured BEFORE any lesson
exists. Model weights never change; the context does. Everything the model proposes is merged
by deterministic code (the ACE shape); everything stored cites the rows that justify it.

## Decisions

- **Unit of experience: gap-life summaries** (user ruling) — one row per CLOSED gap, written by
  code, joining nudges + nudge_decisions + review_items + attribution. Raw decision rows stay.
- **Corrective signal: use what's already saved** (user ruling) — summaries join the manager's
  dismissal/resolution via `escalated_from_nudge`; the planner prompt additionally tells it to
  check its own escalations' fates via `v_review_items`. No new manager UX.
- **Lessons live in a new table** (user ruling) — tenant-scoped, append-only, evidence-cited,
  strike-retirable. Not L3 (scalar/capture-provenance/manager-rendered — all three wrong).
- **Baseline metrics ship first, in this plan** (user ruling) — pure SQL; the pre-lesson
  baseline is unrecoverable later. Paired metrics only (every attention metric has an outcome
  twin) so no single number is gameable.
- **Injection is PUSH, per-firm, in the user message** (recommended, unopposed) — a small
  LESSONS block beside the gap blocks; the briefing-probe finding says pull-only content goes
  unread. Lesson usage is measurable because a decision citing a lesson names its id in
  `reason` (rail-checked lightly: id must exist).
- **Reflector runs SHADOW first, threshold-gated** — no distillation before a firm has 15
  closed summaries; shadow = lessons proposed + logged, nothing stored as active, nothing
  injected. Mirrors the WATCHERS/NUDGES/PLANNER off/shadow/live idiom. `live` is ACCEPTED but
  behaves as shadow in this plan.
- **Promotion at scale = a periodic ADVERSARIAL REVIEWER, not a human** (user ruling
  2026-08-23): human review of proposals is pilot-only scaffolding. The designed mechanism is
  a fortnightly-to-monthly adversarial judge — a model call prompted to REFUTE each proposed
  lesson against its cited evidence (and to re-examine active ones for retirement), promoting
  only what survives. Deliberately NOT built in these phases: the judge needs a corpus of real
  proposals to be designed against, and the shadow phase is what accumulates it. Recorded here
  so the operator script is understood as temporary.
- **Lesson budget is a TOKEN budget, not a count** (user ruling 2026-08-23, refined): the
  active set is bounded by the rendered LESSONS block's size — `LESSONS_BLOCK_BUDGET = 2000`
  chars (~500 tokens/tick, the repo's standing chars-as-token-proxy). Activation is refused
  when the block would exceed the budget (retire or shorten first); render = ALL active
  lessons, bounded by construction. Many short lessons or few long ones — the model's cost is
  what's capped. Proposals are unlimited but expire: neither activated nor refuted within 60
  days → stale (kept, never re-shown).
- **Working hours, pinned ONE way** (review find 8): `working_hours_open` = overlap of
  [asked_at, resolved_at] with the 7am-7pm firm-local ask window, computed from REAL-UTC
  columns + `tenants.timezone` via `at time zone` — never from naive-local `context` values.
  "Within 1 working day" = ≤12 working hours. Phase 1 SQL and Phase 2 TS share this via one
  tested definition each, asserted equal in a test.
- **Whiplash evidence mirrors the planner's own read** (review find 7): "no new evidence
  between" = no job-stamped capture AND no visit minted on the job in the interval, excluding
  manager_only and retracted — the `listJobEvidenceSince` union, reproduced, so the baseline
  measures what the planner actually saw.
- **Lesson text date rail** (implementation decision): weekday/time-of-day words are ALLOWED
  (patterns like "Friday evening" are the content); absolute dates (YYYY-MM-DD, "Aug 23") are
  refused — a lesson is a rule, not an event. New `cleanLessonText`, not `cleanPlannerText`.
- **Metrics views are NOT in SPINE_VIEW_CATALOG** — the catalog is shared with managers'
  query_spine; planner telemetry is operator-facing, so the views get no spine_reader grant
  and a script reads them with service credentials.
- **Deferred, recorded here**: recall-projection widening (planner re-reading its own
  handoffNote/agentContext), write-only column cleanup (`mode`, decision `escalate_after`),
  seat-side memory (ratified: planner is the first host), the at-scale agentic eval (ordered
  after memory by standing user direction).

## Plain-language walkthrough

**Phase 1 — measure how the planner behaves today.** A few SQL views compute, from tables that
already exist: how many gaps get filled and how fast; how many escalations were premature
(answered or dismissed within a working day) vs late; how often decisions flip with no new
evidence; whether extends actually get answered. `npm run metrics:planner` prints the report;
the first run is committed as the baseline snapshot. Nothing changes behavior.

We can measure how the planner behaves today but since the pilot is only a testing environment, we can't really realistically use it as a benchmark because gaps won't get actively closed. We can still have the code for it though in case in the future, we need to use it on a firm that's been running the planner for like a month or something.

**Phase 2 — one story per finished gap.** When a gap closes, a code sweep writes a
`gap_summaries` row: asked when, considered how many times, which verbs, how it ended, what
the manager did with any escalation. Fourteen noisy decision rows become one legible record —
the thing a distiller can actually read.

**Phase 3 — a place for lessons.** A `planner_lessons` table plus the Curator: plain code that
appends a proposed lesson only if it cites real summary rows, retires a lesson after two
contradicting outcomes, and never rewrites anything. No model in this phase.

**Phase 4 — the Reflector, running dark.** A model call (same transport as the planner) reads
a firm's recent summaries and proposes up to three lessons. In shadow: proposals are stored as
`status='proposed'` and logged for human review — nothing reaches any prompt.

**Phase 5 — close the loop, live.** Active lessons render as a small LESSONS block in that
firm's planner prompt; the prompt gains the self-check line (look up your own escalations'
fates); decisions that use a lesson name its id in `reason`; the metrics from Phase 1 become
the before/after judges. Turning a proposed lesson `active` is a HUMAN action for now
(operator review of shadow output) — automatic promotion is a later decision, made against
the baseline.

```
close ─▶ gap_summaries ─▶ (≥15/firm) Reflector ─▶ proposed ─▶ human ─▶ active
                                                                        │
   next tick's prompt: gaps + LESSONS block  ◀───────────────────────────┘
        │
        └─▶ decisions cite lesson ids ─▶ metrics say keep / Curator strikes
```

## Secrets & env preflight

- **Phase 1:** none new. Reads the pilot DB via existing service credentials (script uses
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` from `.env`, already required).
- **Phase 2:** none new. Pilot migration via `mcp__supabase-test__apply_migration` FIRST
  (deploy-does-not-migrate).
- **Phase 3:** none new. Same migration-first discipline.
- **Phase 4:** `REFLECTOR_MODE` env (off/shadow/live; unset = off) on lifecycle-heart — set by
  the user in Render when Phase 4 deploys (no secret; a mode flag).
- **Phase 5:** none new.

## Phase 1: Baseline metrics

### What this phase does
Computes the planner's current behavior from existing tables; commits the baseline.

### Changes required

**`supabase/migrations/<ts>_planner_metrics_views.sql`** (new) — four views, service-role only
(no spine_reader grant, NOT added to SPINE_VIEW_CATALOG):
- `mv_gap_outcomes` — per closed gap: kind, asked_at, resolved_at, working-hours open, terminal
  status bucket (answered / manager / abandoned), closed-by-technician boolean
  (answered_by_capture_id present).
- `mv_escalation_fates` — per escalation decision: review-item fate + latency. The link is
  `review_items.detail->>'escalatedFromNudge'` (a JSONB key, NOT a column — review find 9):
  join as TEXT against `nudge_id::text` behind the same regex guard `v_review_items` uses
  (a bare `::uuid` cast over one malformed value kills the whole query). premature =
  answered-or-dismissed ≤12 working hours after the escalation; late = gap silent >2× its
  escalate_after before any escalation.
- `mv_whiplash` — consecutive decision pairs per gap where the verb flipped with no evidence
  between, per the pinned union definition above.
- `mv_extend_effectiveness` — extends whose gap was answered before the extended deadline.
All four views: `revoke all ... from anon, authenticated` in the migration (views cannot carry
RLS and have no GUC fail-closed guard — without the revoke they are a cross-tenant PostgREST
read surface on the publishable key, the recorded query_spine-ACL failure class), plus an
ACL-asserting DB test (the querySpine.test.ts pattern).

**`scripts/planner-metrics/report.mjs`** (new) + `package.json` script `metrics:planner` —
queries the views, prints paired metrics with denominators (never a rate without its n), and
`--markdown` writes the dated snapshot.

**`docs/planner-baseline-2026-08.md`** (new) — the committed first snapshot, labeled with its
data window and caveat (one tenant, small n; tripwire not proof).

### Automated verification
- [x] gates pass (suite 2201); DB tests cover all four views (premature, no-item, late,
  outcome buckets incl. the expiry-path manager handoff, whiplash with/without evidence,
  extend answered-in-time + pending), ACLs asserted, SQL↔TS parity incl. a DST fall-back day
  and odd-second boundaries. Three review-fix rounds folded — most materially: `late` was
  structurally dead as first specced and is redefined against the original 24h allowance
- [x] `npm run metrics:planner` runs against the LOCAL stack in the test

### Live verification (agent-executable)
- Prerequisites: pilot DB MCP (read-only queries).
- [x] report runs against the pilot; snapshot committed (v2 views: manager handoffs 55%,
  late 2/6 where the first definition read 0 — an artifact); attic-fan specimen:
  fate=resolved, premature=true, by_planner=false, 0.11 working hours to auto-heal

*No manual items — continue.*

## Phase 2: Gap-life summaries

### What this phase does
The durable experience unit: one code-written row per closed gap.

### Changes required

**`supabase/migrations/<ts>_gap_summaries.sql`** (new) — `gap_summaries`: tenant_id, nudge_id
(unique, **FK references nudges(id) on delete cascade**), job_id, kind, subject label,
asked_at, closed_at, terminal status + resolution, working_hours_open, per-verb counts (jsonb
`arc`), extended_to, escalated bool, manager_fate ('dismissed'|'resolved'|'still_open'|'none'
+ resolution text + latency), answered_by_capture_id, created_at. Append-only by convention.
Standard posture: enable RLS + revoke from anon/authenticated. **Name the table in BOTH
cleanup lists** — `scripts/seed.mjs` and `scripts/spine-eval/world.mjs` (the tenant_profiles
trap, eng-mem §1; cascade coverage is never left incidental).

**`src/db/gapSummaries.ts`** (new) — `insertGapSummary`, `listUnsummarizedClosedNudges`
(closed nudges with no summary row, paged), `listRecentSummaries(tenantId, limit)`.
**Escalation holdback (review find 1 — the corrective signal's life depends on this):** an
escalated gap is NOT summarizable while its review item is still open; it becomes summarizable
when the item resolves/dismisses OR 7 days after close (then manager_fate 'still_open').
Without this, the append-only row freezes manager_fate:'none' before the manager ever acts and
the Reflector reads "the manager did nothing" forever.
**`src/db/reviewItems.ts`** — new accessor `findItemForNudge(tenantId, nudgeId)` filtering on
`detail->>escalatedFromNudge` (the sweep cannot use v_review_items — GUC-gated, query_spine
only).

**`src/jobs/summarize.ts`** (new) — `runGapSummaries(nowIso)`: for each unsummarized closed
gap, compute the row from nudges + listDecisionsForNudges + review_items
(`escalated_from_nudge`) + attribution stamp. Idempotent (unique nudge_id, insert-on-conflict
do nothing); one bad gap never blocks the sweep (per-row isolation, the lifecycle idiom).

**`src/jobs/lifecycle.ts`** — new step AFTER compose (watchers → planner → compose →
summarize), reported in the summary JSON; absent-table → `skipped` via the isMissingCostLedger
cause-code idiom, never an error. Run `npm run gen:types:local` after the migration (primary
checkout only — grep project_id first) and commit the regenerated types.

### Automated verification
- [x] gates + tests: closed-gap known arc exact row; idempotence; no-decisions gap; holdback
  full cycle (open item defers → dismissal completes with latency; timeout → still_open;
  NO-item escalations summarize immediately as 'none' — the once-ever dedup means their item
  can never appear); extended_to reads applied extends only; the oldest-page anti-join stall
  fixed server-side

### Live verification (agent-executable)
- Prerequisites: pilot DB MCP; pilot migration applied BEFORE merge/deploy.
- [x] first post-deploy tick (2026-08-23 5:20 PM firm-local) wrote 7 pilot summaries: Teddy
  Vance arc {leave:1, close:1} fate none ✓; attic-fan escalated/resolved with the auto-heal
  text, 25.1 working hours ✓; the 4 open-item escalations correctly HELD BACK. Confirmed
  follow-up (rides Phase 4): expiry-path handoffs (failed + citing item) freeze fate 'none' —
  the holdback must cover them too

*No manual items — continue.*

## Phase 3: The lessons store and the Curator

### What this phase does
Where lessons live and the code that guards them. No model call yet.

### Changes required

**`supabase/migrations/<ts>_planner_lessons.sql`** (new) — `planner_lessons`: tenant_id, id,
text, scope ('firm' now; column ready for 'person'), evidence (jsonb array of gap_summaries
ids, non-empty CHECK), status ('proposed'|'active'|'retired'), strikes int, proposed_at,
activated_at, retired_at, retired_reason. Text is append-only (status/strikes are the only
mutable columns; enforced in the typed layer). Enable RLS + revoke from anon/authenticated —
`text` is INJECTED INTO THE PLANNER'S PROMPT, so an unprotected INSERT is direct prompt
injection. References only tenants → **name it in seed.mjs + world.mjs cleanup lists** or
reseeds leave a stale active lesson haunting the fresh world. gen:types after.

**`src/teamLead/lessons.ts`** (new) —
- `cleanLessonText(raw)`: cap 300 chars, flatten, refuse absolute dates (YYYY-MM-DD, month
  names + digits), allow weekday/time-of-day words; refuse the footer register phrase.
- `proposeLesson(input)`: verifies every cited evidence id exists in gap_summaries for that
  tenant (refuse otherwise), inserts as 'proposed'.
- `strikeLesson(tenantId, id, why)`: strikes+1; at 2 → 'retired' + reason.
  `activateLesson(tenantId, id)` — both tenant-scoped (operator-script callers paste ids;
  a wrong paste must not cross tenants — review find 10). Activation REFUSES when the
  resulting rendered block would exceed `LESSONS_BLOCK_BUDGET` (the token-budget ruling) —
  retire or shorten first, then activate.
- `renderLessonsBlock(tenantId)`: ALL active lessons as numbered bullets with ids; total
  bounded by the budget at activation time, by construction.

### Automated verification
- [x] gates + tests (12): evidence refusal; two-strike retirement (history settled — a third
  strike cannot rewrite it); budget refusal; date rail allows "Friday evening" and ordinary
  words ("maybe", "separate"), refuses YYYY-MM-DD / "Aug 23" / "Aug 23rd"; tenant scoping;
  stale expiry; ACL pin; byte-level text immutability

### Live verification
- Prerequisites: pilot migration applied.
- [x] schema verified on the pilot via information_schema: gap_summaries (20 cols) and
  planner_lessons (11 cols) both present, RLS on; metrics v2 views applied

*No manual items — continue.*

## Phase 4: The Reflector (shadow)

### What this phase does
The distiller, dark: proposes lessons, stores them as 'proposed', injects nothing.

### Changes required

**`supabase/migrations/<ts>_reflector_runs.sql`** (new) — `reflector_runs (tenant_id,
ran_at)`: the run marker, written on EVERY run including zero-proposal ones (recording runs on
their proposals leaves quiet runs unmarked and re-fires a billed call daily on unchanged
input — review find 6; ops_events is unusable here: host FK + one-open index). RLS + revoke;
name in both cleanup lists.

**`src/teamLead/reflector.ts`** (new) — `runReflector(nowIso, mode)`:
- Per tenant, gate: firm-local hour ≥ 2 AND no reflector_runs row today (firm-local day) AND
  ≥15 gap_summaries AND ≥5 new since the last run — otherwise skip counted. Statelessly
  re-checkable all day (a late cron never costs the whole day).
- ONE forced-tool call (`runForcedTool`, same transport/provider switch as compose): system
  prompt = the distillation doctrine (propose ≤3 lessons; each must cite ≥3 summary ids that
  genuinely support it; a lesson is a RULE about this firm, never an event, never a person's
  private detail; weekday words yes, dates no); user = the firm's last 40 summaries rendered
  compactly + currently active/retired lesson texts (so it neither re-proposes an active
  lesson nor resurrects a retired one).
- Forced-tool params PINNED (review find 5): `maxTokens: 2000`, `reasoningEffort: 'none'` —
  GLM thinks by default and a small budget truncates (measured); 3 lessons + evidence uuids do
  not fit compose's 300. On the Anthropic path the doctrine prompt may sit under the 512-token
  cache minimum — the silent cache no-op is known; never count caching in Reflector costs.
- Output through `cleanLessonText` + `proposeLesson` (evidence verified). Log every proposal
  loudly. `REFLECTOR_MODE` off/shadow/live; unset = off silently; bad value = stepError; live
  = shadow-equivalent in this plan (stated in code).

**`src/jobs/lifecycle.ts`** — Reflector step after summarize (the gate above owns dailiness).

### Automated verification
- [x] gates + tests (9 reflector + lifecycle contract): each gate pinned INDEPENDENTLY (review
  catch — the first fixtures let either gate produce the same skip); zero-proposal AND failed
  calls write markers (failed = ok:false, bounding the day WITHOUT advancing the freshness
  watermark); evidence refused whole; missing-table rethrow → lifecycle 'skipped' not
  buried-ok:true; render-time flattening of everything crossing DB→prompt; live-as-shadow

### Live verification (agent-executable)
- Prerequisites: pilot DB MCP; Render env `REFLECTOR_MODE=shadow` set by user; deploy.
- [ ] pilot gate honestly SKIPS after deploy + REFLECTOR_MODE=shadow (7 summaries < 15 today);
  first real shadow proposals reviewed with the user in a follow-up session

### Manual verification
- [ ] you set `REFLECTOR_MODE=shadow` on lifecycle-heart (my env writes are classifier-blocked)

---
*Pause after this phase — the env flag is yours.*

## Phase 5: Close the loop

### What this phase does
Active lessons reach the prompt; usage becomes measurable; the planner checks its own record.

### Changes required

**`src/teamLead/planner.ts`** — per-tenant `renderLessonsBlock` result appended to the user
message after the gap blocks, under `LESSONS (from this firm's own history):`; absent/empty →
nothing rendered (zero-cost until a lesson is activated). A decision whose `reason` names a
lesson id that doesn't exist for that tenant is NOT refused (the rail stays light) but logged.

**`src/teamLead/plannerPrompt.ts`** — two additions: the LESSONS contract ("lessons are your
own distilled history; when one changes your decision, name its id in reason") and the
self-check line ("before escalating, you may check how your past escalations ended:
spine_read over v_review_items where escalated_from_nudge is not null").

**`scripts/planner-metrics/report.mjs`** — lesson-usage section: decisions citing lesson ids,
joined to their gaps' eventual outcomes (the keep/kill evidence).

**Activation** (pilot scaffolding — see the promotion Decision): reviewing shadow proposals
and flipping one to 'active' is a human act via a small `scripts/planner-metrics/lessons.mjs`
(list / activate / retire) — no MCP tool, no manager exposure. The script is the temporary
stand-in for the future adversarial judge; its interface (list proposals with evidence,
accept/retire verdicts) is deliberately the judge's interface, so the judge later replaces
the human without reshaping the store.

### Automated verification
- [x] gates + tests: LESSONS renders for active only / absent for none (anti-drift lock holds
  byte-for-byte with and without a block); prompt pins both additions; usage join tested in
  SQL and executed via the real report; live/shadow citations counted apart (review ruling)

### Live verification (agent-executable)
- Prerequisites: deploy; at least one shadow proposal reviewed and activated (may be a later
  session — the phase is complete when the machinery is verified with a TEST lesson on the
  local stack end-to-end; pilot activation waits for real proposals).
- [x] local-stack E2E incl. the DEFAULT seam (review catch — every other test stubbed it): a
  real runPlanner tick against the real DB rendered a real activated lesson's text + short id

### Manual verification
- [ ] first real pilot lesson: you read the shadow proposals with me and rule which (if any)
  becomes active

---
*Pause — the first activation is a human judgment.*
