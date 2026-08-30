---
date: 2026-08-29
branch: main
commit: 378bcb2
topic: Build 3 — the planner's memory: the ground it stands on (what it replaces, the write threshold, prompt cost, what a tick already sees, the per-firm-table precedent, and the capture obligations)
supersedes: nothing
---

**On `supersedes`.** This overturns no earlier decision. It documents ground that three earlier
documents describe in part — `thoughts/shared/research/2026-08-28-the-harness-audit.md` (the rebuild's
case), the ⑤ memory-architecture plan of 2026-08-23 (which built the lesson machinery described in §1),
and `docs/engineering-memory.md` §6a build 3 (the user direction). Where this document contradicts a
belief, it is a belief about the *pilot's live state*, not about a decision — see §1.6.

## Summary

Build 3 replaces the way the planner remembers things. Today it has a **lessons** system: once a
day a second model (the "Reflector") reads finished gap histories and *proposes* short rules about
the firm; a human then runs a command-line script to *activate* one; only then does it appear in the
planner's prompt. The plan is to replace all of that with **.md files the planner writes and
organises itself**, firm-scoped, stored in a table shaped like a filesystem — plus the user's
2026-08-29 direction that a tick should **reconcile that memory against the database before it
plans**.

The single most consequential fact this research turned up: **the lessons system has never once
reached the planner.** The pilot holds 3 lessons, all `proposed`, **zero `active`** — and
`renderLessonsBlock` returns an empty string unless a lesson is `active`. So every planner tick the
pilot has ever run was sent an empty lessons block, while the system prompt spends a paragraph
explaining a LESSONS block the model has never seen. Build 3 is therefore not replacing a working
mechanism; it is replacing one that has been inert since it shipped.

Two other findings shape what build 3 has to do. **The planner's tool allowlist and the tool schemas
it is actually handed disagree** — `TEAM_LEAD_TOOL_NAMES` lists four tools, the loop is handed two —
so adding a write verb means editing two lists, and two of the four names currently on the allowlist
are unreachable in exactly the way that file's own comment condemns. And **the prompt is almost
entirely fixed overhead**: by the repo's own 4-chars/token proxy the system prompt plus tool schemas
come to ~6.4K tokens, against a measured 6,529 input tokens for a whole one-gap tick — so per-gap
content is a small fraction of what is sent, and "the index is in every prompt" competes with a
floor that is already nearly the whole bill.

## Entry points

- `src/teamLead/lessons.ts:1` — the Curator: the lesson store's typed layer and every guard
- `src/teamLead/reflector.ts:100` — `REFLECT_TOOL`, the daily distiller's forced-tool contract
- `src/teamLead/reflector.ts:169` — `runReflector`, one call per eligible firm per day
- `src/jobs/lifecycle.ts:605` — step 12, the Reflector's cadence gate (`REFLECTOR_MODE`)
- `src/teamLead/planner.ts:1888` — the only place a lesson reaches a prompt
- `src/teamLead/planner.ts:1979` — the light lesson-usage rail (`knownShortIds`)
- `src/teamLead/identity.ts:22` — `TEAM_LEAD_TOOL_NAMES`, the dispatch allowlist
- `src/mcp/server.ts:1695` — `TEAM_LEAD_TOOLS`, the schemas actually handed to the loop
- `src/mcp/server.ts:2373` — the deny-by-default gate, and its stated rule
- `src/teamLead/planner.ts:1515` — `buildPlannerUserMessage`
- `src/teamLead/planner.ts:1757` — the per-tenant read sequence
- `scripts/planner-metrics/lessons.mjs:52` — the human activation surface (a CLI)

## Key files

| Path | Role | Key exports |
|---|---|---|
| `src/teamLead/lessons.ts` | The **Curator** — every guard on stored lessons | `LESSONS_BLOCK_BUDGET`, `LESSON_TEXT_MAX`, `PROPOSAL_STALE_DAYS`, `RETIRE_STRIKES`, `cleanLessonText`, `proposeLesson`, `listLessons`, `renderLessonsBlock`, `activateLesson`, `strikeLesson`, `getLesson`, `expireStaleProposals` |
| `src/teamLead/reflector.ts` | The **distiller**, running dark | `MIN_SUMMARIES`, `MIN_NEW_SINCE_LAST_RUN`, `REFLECT_FROM_HOUR`, `REFLECT_TOOL`, `REFLECT_SYSTEM`, `runReflector` |
| `src/teamLead/identity.ts` | The identity and its tool ceiling (30 lines) | `TEAM_LEAD_REF`, `TEAM_LEAD_TOOL_NAMES` |
| `src/mcp/server.ts` | The one door: `dispatch`, the gates, the tool schemas | `dispatchForIdentity`, `TEAM_LEAD_TOOL_SCHEMAS` |
| `src/teamLead/plannerPrompt.ts` | `PLANNER_SYSTEM` + the terminal tool | `PLANNER_SYSTEM`, `SUBMIT_PLAN_TOOL` |
| `src/teamLead/planner.ts` | The tick: reads, gap views, the loop, apply, record | `buildPlannerUserMessage`, `buildGapView`, `GapView`, `EVIDENCE_PER_GAP`, `runPlanner` |
| `src/db/tenantProfiles.ts` | Per-firm **string** table + patch accessor | `PROFILE_STRING_FIELDS`, `upsertTenantProfile`, `profileEcho`, `profileGaps` |
| `src/db/tenantSettings.ts` | Per-firm **number** table + tolerant read | `SETTINGS_NUMBER_FIELDS`, `patchTenantSettings`, `resolveSettings`, `readSettingsTolerantly` |
| `src/db/nudgeDecisions.ts` | The planner's own audit trail | `NudgeDecisionInput`, `recordNudgeDecisions` |
| `src/composio/logIngest.ts` | Outbound agent actions → L1 | `EMAIL_SEND_SLUGS`, `READ_SLUG_PREFIXES` |
| `scripts/planner-metrics/lessons.mjs` | The operator's lesson console (CLI) | `list` / `activate` / `strike` |
| `supabase/migrations/20260824010000_planner_lessons.sql` | The lesson table | — |
| `supabase/migrations/20260824030000_reflector_runs.sql` (+ `…040000_…_ok.sql`) | The run marker | — |

---

## 1. What build 3 replaces — the lesson machinery, in full

### 1.1 The table

`supabase/migrations/20260824010000_planner_lessons.sql`. Columns: `id`, `tenant_id` (FK, cascade),
`text`, `scope` (`firm`|`person`), `evidence` (JSONB, **must be a non-empty array**, CHECK-enforced),
`status`, `strikes`, `proposed_at`, `activated_at`, `retired_at`, `retired_reason`. Index on
`(tenant_id, status)`. RLS enabled, `revoke all from anon, authenticated`.

The migration header states why the revoke is load-bearing beyond convention: **`text` is rendered
into the planner's prompt, so an unprotected INSERT via the publishable key would be direct prompt
injection into the planner.** Any successor store inherits that property the moment its content
reaches a prompt.

It also notes the table "references only tenants → named in BOTH cleanup lists" —
`scripts/seed.mjs:180-186` (conditionally, only if the table exists) and
`scripts/spine-eval/world.mjs:132` and `:195`. No cascade reaches it from customers/jobs, so a
reseed that forgot it would leave a stale active lesson haunting a fresh world.

### 1.2 The status lifecycle

```
                    proposeLesson()            activateLesson()
   (Reflector) ───────────────────► proposed ──────────────────► active ──┐
                                       │        (human, CLI)              │
                    expireStaleProposals()                                │ strikeLesson() ×2
                    60 days, no verdict    ▼                              ▼
                                        stale ──(activatable by id)──► retired  (terminal)
```

- **`proposed`** — the only status the model can create. `proposeLesson`
  (`lessons.ts:56`) refuses on: non-string text, empty text, an absolute date or month-and-day
  (`ABSOLUTE_DATE` / `MONTH_AND_DAY`, `lessons.ts:28-32`), the phrase "note for the assistant", zero
  evidence, or **any cited `gap_summaries` id that does not exist for that tenant**. Evidence is
  checked whole and refused whole — the comment: *"a lesson with laundered evidence is worse than no
  lesson."* Text is flattened to `LESSON_TEXT_MAX = 300`.
- **`active`** — the only status `renderLessonsBlock` reads (`lessons.ts:107`). Reached **only**
  through `activateLesson`, which is called from **one place in the repo**:
  `scripts/planner-metrics/lessons.mjs:55`.
- **`stale`** — a proposal that sat 60 days (`PROPOSAL_STALE_DAYS`) without a verdict. Kept, excluded
  from the default listing, but **still activatable by explicit id** (`lessons.ts:126-128`, review
  F6: the sweep must not veto a human's just-made decision).
- **`retired`** — terminal. `activateLesson` refuses it outright (*"a retired lesson never comes
  back"*), and `strikeLesson` returns early on it so a third strike cannot rewrite
  `retired_at`/`retired_reason` (review F7).

### 1.3 `strikeLesson` and the two-strike retirement — and its missing feeder

`lessons.ts:145`. Increments `strikes`; at `RETIRE_STRIKES = 2` it also sets
`status='retired'`, `retired_at`, `retired_reason` (flattened to 300). The update carries
`.eq('strikes', lesson.strikes)` as a **lost-update guard** (review F4) and throws
`"strikeLesson raced"` when the row moved.

**Nothing automatic ever calls it.** The only caller in the repo is
`scripts/planner-metrics/lessons.mjs:61`. The doctrine sentence *"Two contradicting outcomes retire a
lesson"* (`lessons.ts:22`) describes a mechanism with no detector behind it — a human must notice the
contradiction and type the command.

### 1.4 `renderLessonsBlock` and `LESSONS_BLOCK_BUDGET` — where the budget is actually enforced

```
LESSONS_BLOCK_BUDGET = 2000   // CHARS, the repo's standing ~4-chars/token proxy → ~500 tokens
```

The budget is **not** enforced at render time. `renderLessonsBlock` (`lessons.ts:104`) lists all
`active` lessons and joins them as numbered bullets with an 8-hex short id — no length check at all.
The check lives in **`activateLesson`** (`lessons.ts:130-135`): it renders the prospective block
(existing actives + this one) and throws
`"activation refused: rendered block would be N chars (budget 2000) — retire or shorten first"`.

So: **the block is bounded by construction, at activation, by refusing the human.** There is no
overflow path at render time, because overflow cannot be reached. This is the property most directly
in tension with build 3, where the writer is the model and there is no activation step to refuse at.

Render shape, from `renderBullets` (`lessons.ts:98`):

```
  1. <text> [a1b2c3d4]
  2. <text> [e5f6a7b8]
```

### 1.5 The human activation surface

`scripts/planner-metrics/lessons.mjs`, run as `npm run lessons:planner -- <list|activate|strike>
--tenant <uuid> [--id <uuid>] [--why "..."]`. It imports the **compiled** Curator from `dist/` so
every guard is production code rather than a parallel implementation. It requires `DATABASE_URL`.

Its header calls itself *"pilot-stage scaffolding whose interface … is deliberately the future
adversarial judge's interface, so the judge later replaces the human without reshaping the store."*

Factually: **the activation surface is a laptop shell with the production database URL.** It is not
Telegram, not MCP, not the board. Under the repo's `telegram-only-surface` product principle this is
the only firm-facing state transition with no Telegram-reachable tool.

### 1.6 What actually happened on the pilot — the machinery has never fired

Read-only query against the pilot (`planner_lessons`, `reflector_runs`, `gap_summaries`):

| | count |
|---|---|
| lessons `proposed` | **3** |
| lessons `active` | **0** |
| lessons `retired` / `stale` | 0 |
| `reflector_runs` rows | 1 |
| `gap_summaries` rows | 19 |

Consequences, all following directly from the code above:

- `renderLessonsBlock` has returned `''` on **every planner tick the pilot has ever run**, so
  `buildPlannerUserMessage` has never appended a LESSONS section.
- The **LESSONS paragraph in `PLANNER_SYSTEM`** (`plannerPrompt.ts`, ~9 lines, sent on every single
  tick) describes a block the model has never been shown. It is dead text that is nonetheless
  billed on every turn of every tick.
- The **lesson-usage rail** at `planner.ts:1979` builds `knownShortIds` from that empty block, so its
  set has always been empty. Its only effect to date would be to log *"cites unknown lesson"* if the
  model ever invented a bracketed 8-hex id unprompted.
- `MIN_SUMMARIES = 15` is satisfied (19 summaries), and one Reflector run has occurred — so the
  distiller is not wholly untested, but with `MIN_NEW_SINCE_LAST_RUN = 5` anchored on the last
  *successful* run it will only fire again after 5 more summaries.

### 1.7 The Reflector as author

`src/teamLead/reflector.ts`. One `runForcedTool` call per eligible firm per day.

**Gates** (all must pass, `reflector.ts:180-188`), evaluated in the firm's own timezone:
`hour >= REFLECT_FROM_HOUR (2)` · not `ranToday` · `countSummaries >= MIN_SUMMARIES (15)` ·
`newSinceLastRun >= MIN_NEW_SINCE_LAST_RUN (5)`.

The three constants carry an explicit note that they were **deliberately not made per-firm** in build
2: *"they gate a SHADOW-mode distiller whose output reaches no prompt. They are not statements about
how a firm operates — they are how much evidence WE want before spending a call."*

**Input** (`reflector.ts:196-204`): the 40 most recent `gap_summaries` rendered one line each by
`renderSummary` (id, kind, subject, status, resolution, working-hours-open, considered count, arc,
manager fate), plus the ACTIVE lessons ("do not re-propose") and RETIRED lessons ("never resurrect").
Everything crossing DB → prompt goes through `flatten` — the comment names the attack: *"embedded
newlines could forge corpus lines or a fake ACTIVE section."*

**Output**: `propose_lessons`, at most 3, each with `text` and **≥3** evidence ids. Refused *whole*
when evidence is not an array of ≥3 strings (review F4: *"providers honour minItems only as a
hint"*). Model settings are pinned: `maxTokens: 2000`, `reasoningEffort: 'minimal'`, with a comment
that GLM thinks by default and small budgets truncate.

**Run marker**: `insertReflectorRun(tenantId, proposedHere, callOk)` in a `finally`, so it is written
even on zero proposals. `ok=false` on a failed call means `ranToday` still bounds the day's billing
while `newSinceLastRun` keeps anchoring on the last *successful* run (migration
`…040000_reflector_runs_ok.sql`, review F2).

**Mode**: `REFLECTOR_MODE` env var, `off` when unset (`lifecycle.ts:610-614`). The module header
states that `live` is **deliberately shadow-equivalent** — activation stays a human act either way.

### 1.8 What would be orphaned by deletion

| If deleted | Orphaned |
|---|---|
| `planner_lessons` table | both cleanup lists (`seed.mjs:186`, `world.mjs:132`,`:195`); the `evidence` FK-by-convention to `gap_summaries` |
| `renderLessonsBlock` | `PlannerDeps.lessons` (`planner.ts:362`), the try/catch at `:1886-1891`, the `lessonsBlock` parameter of `buildPlannerUserMessage` (`:1519`), the LESSONS branch at `:1532` |
| the lessons block | the **LESSONS paragraph of `PLANNER_SYSTEM`**, and the `knownShortIds` rail at `planner.ts:1979-1990` |
| `activateLesson`/`strikeLesson` | `scripts/planner-metrics/lessons.mjs` entire (its `list` also reads `gap_summaries` for evidence display) |
| `runReflector` | `lifecycle.ts` step 12 (`:605-620`), `LifecycleSummary.reflector` (`:122`), `ReflectorDeps`, `reflector_runs` + both its migrations, `latestReflectorRunAt` / `latestSuccessfulReflectorRunAt` / `insertReflectorRun` in `src/db/reflectorRuns.ts`, and the `REFLECTOR_MODE` env var |
| `cleanLessonText` | the date rail described in §6 — the *only* implementation of "a lesson is a rule, not an event" |

`countSummaries` / `listRecentSummaries` / `gap_summaries` itself are **not** orphaned: gap summaries
are written by lifecycle step 11 and read by `scripts/planner-metrics/report.mjs` independently.

---

## 2. The tool surface and the write threshold

### 2.1 The gate, and its stated rule

`src/mcp/server.ts:2373`:

```ts
if (identity.technicianRef.startsWith('spine:') && !TEAM_LEAD_TOOL_NAMES.has(name)) {
  throw new Error('the team-lead identity is capped to read/ask — tool not allowed');
}
```

The comment above it is the rule build 3 must satisfy, verbatim:

> There is no human behind a `spine:` identity to confirm anything, so **nothing irreversible or
> externally visible may dispatch for it**; this gate is the mechanism, the prompt is merely
> steering.

`identity.ts:14-18` states the same rule and adds: *"deny-by-default, so a forgotten entry fails
closed (targetGuard doctrine)"*.

**Order of gates inside `dispatch`** (`server.ts:2317` onward) — the sequence a new tool passes:

```
dispatch(name, args, {identity})
  1. identity present?                                    → throw if not
  2. ONE roster read: getTechnician(tenantId, ref)        → deactivated badge? throw
     (spine:team-lead has NO roster row → caller = null, activeManager = false)
  3. cost event appended: provider 'spine', sku 'tool_call', metadata {tool: name}
     ── deliberately BEFORE the tier gate: a refused call still burned a decision
  4. spine: namespace ceiling      → TEAM_LEAD_TOOL_NAMES.has(name)      ← THE GATE
  5. inverse ceiling               → TEAM_LEAD_ONLY_TOOL_NAMES, refused to non-spine badges
  6. ADMIN_TOOL_NAMES              → requires an active manager
  7. …then the tool body switch
```

Note step 3: **every planner tool call is already a billed, recorded event** with the tool name in
`cost_events.metadata`. A memory-write tool inherits that for free.

### 2.2 The allowlist and the schemas disagree

| | contents |
|---|---|
| `TEAM_LEAD_TOOL_NAMES` (`identity.ts:22`) — what may **dispatch** | `spine_read`, `recall_decisions`, `get_customer_context`, `resolve_date` |
| `TEAM_LEAD_TOOLS` (`server.ts:1695`) — the **schemas** handed to the loop | `spine_read`, `recall_decisions` |

`lifecycle.ts:512` passes `tools: [...TEAM_LEAD_TOOL_SCHEMAS]`; `planner.ts:1907` appends
`SUBMIT_PLAN_TOOL`. So the planner's model sees **three** tools. `runToolLoop` builds its `allowed`
map from exactly those and refuses anything else *before* the executor
(`toolLoop.ts`, "deny-by-default, mirroring the dispatch gate").

**Therefore `get_customer_context` and `resolve_date` are unreachable by the planner** — not gated
out, simply never offered. This is the same condition `identity.ts:20-21` records for `query_spine`
("*A name on an allowlist that cannot dispatch is a lie about what this identity can do*") and
removed it for; two names have since drifted into the same state by the other route.

For build 3 this is the concrete requirement: **a write verb needs an entry in *both* lists.** One
alone yields either a tool the model can see and cannot call, or a tool it may call and never knows
exists.

### 2.3 The asymmetry: the write the planner already performs is not a tool

`applyDecision` (`planner.ts:1550`) performs real writes — `markNudgeQueued`, `setNudgeSchedule`,
`markNudgeOutcome`, `setNudgeAnsweredBy`, `markNudgeGroupQueued`. None of them goes through
`dispatch`.

```
                    ┌─ TOOL PATH ────────────────────────────────────┐
  model calls  ───► │ runToolLoop.allowed  →  dispatchForIdentity     │
  spine_read        │   → roster read → cost event → spine: ceiling   │ ──► read
                    └────────────────────────────────────────────────┘

                    ┌─ PLAN PATH ────────────────────────────────────┐
  model calls  ───► │ submit_plan is the TERMINAL tool. Its executor  │
  submit_plan       │ runs validateDecisions IN-PROCESS. runToolLoop  │
                    │ returns. THEN planner.ts calls applyDecision    │ ──► WRITE
                    │ directly — never through dispatch.              │
                    └────────────────────────────────────────────────┘
```

So the planner already changes the world, and the gate that says its identity is "capped to read/ask"
has never seen those writes. What makes that consistent rather than a loophole is *where the
authority sits*: `submit_plan` returns a **plan**, and code re-checks every rail and performs every
action after the loop returns (`plannerPrompt.ts` header: *"Prompt rules are steering, never
enforcement"*). The model proposes; code disposes.

A memory-write **tool** would be the first time the model's call *itself* mutates durable state
inside the loop, with no post-loop validation stage between the call and the write. That is the
structural difference build 3 introduces, independent of whether the write is "irreversible or
externally visible".

---

## 3. The prompt, and what it costs

### 3.1 What `buildPlannerUserMessage` assembles, in order

`planner.ts:1515-1535`:

1. `Right now it is <firmClockLine(nowIso, tz)>.`
2. `In UTC that instant is <nowIso> — use UTC for any notBefore you write.`
3. blank
4. `This firm has N open gap(s).`
5. blank
6. **every gap's `block`**, joined by a blank line
7. *(only if non-empty)* blank, `LESSONS (from this firm's own history):`, `lessonsBlock`

The lessons block is **last**, after all gap content. The comment records why it is pushed at all:
*"the briefing-probe finding: pull-only content goes unread"* — and *"Empty until a human activates a
lesson — zero cost until then."*

### 3.2 The fixed floor, measured

Measured from the compiled build (`JSON.stringify` length for schemas; the repo's standing ~4
chars/token proxy):

| component | chars | ≈ tokens |
|---|---|---|
| `PLANNER_SYSTEM` | 15,111 | ~3,778 |
| `spine_read` schema (carries `SPINE_VIEW_CATALOG`) | 5,544 | ~1,386 |
| `submit_plan` schema | 3,696 | ~924 |
| `recall_decisions` schema | 1,457 | ~364 |
| **fixed floor (system + all three schemas)** | **25,808** | **~6,452** |

Against this, the pilot's measured turn-1 input for a **one-gap** tick was **6,529 tokens**
(`cost_events`, 2026-08-29T17:31:01Z).

The two numbers are close enough to establish the shape — **the prompt is overwhelmingly fixed
overhead, and per-gap content is a small fraction of it** — but they cannot both be exact: the
residual leaves implausibly little room for the user message. Either the provider tokenises this text
more efficiently than 4 chars/token, or the schemas are serialised more compactly on the wire than
`JSON.stringify` renders them. Recorded as an open question rather than resolved by arithmetic.

### 3.3 How the prompt scales with gap count

Per-gap `block` is built by `buildGapView` (`planner.ts:649-880`). Its lines, in order:
`gap <id>` · `kind` · `about` (job title + customer) · `job id` · `person` · `state` ·
`noticed Nh ago` · `asked Nh ago | not yet` · *(if present)* `the question asked:` flattened to
`QUESTION_SHOWN_CHARS` · *(cost gaps only)* `THE RECORD:` · *(if held)* `currently held until:` ·
*(if asked)* `escalates automatically at:` · `dates you may use…` (up to 3 labels) ·
*(if any history)* the `historyLine` · then the evidence and money sections.

The two caps that bound growth:

- **`EVIDENCE_PER_GAP = 6`** (`planner.ts:335`) applied twice — `.slice(-6)` on the relevant captures
  (`:681`) and `.slice(-6)` on money rows (`:732`). The money cap's comment names the second reason:
  `moneyOnRecord` is written **permanently into `nudges.resolution`**, so an uncapped block would be
  a multi-kilobyte durable row, not just a big prompt.
- **`historyLine`** (`planner.ts:570-600`) is **one line regardless of history length** — it renders
  `watched since <label> — considered N×` plus the last non-`unmentioned` action. The detail is
  pulled with `recall_decisions`. This is the existing worked example of "push the shape, pull the
  content", which is exactly the pattern build 3's index/files split proposes.

So per-gap cost is roughly constant (bounded by `EVIDENCE_PER_GAP` and the one-line history), and
total user-message cost is approximately linear in open-gap count.

---

## 4. What the planner already sees each tick

### 4.1 Every read, per tenant, per tick

In order, from `planner.ts:1757`:

| # | Read | Bound | Skipped when |
|---|---|---|---|
| 1 | `listNudges(tenantId, OPEN_NUDGE_STATUSES)` then filtered to registered kinds | statuses `pending`/`queued`/`asked` | never |
| 2 | `get(tenantId)` (tenant row → timezone) | one row | no open gaps |
| 3 | `getSettings(tenantId)` = `readSettingsTolerantly` | one row | no open gaps |
| 4 | `listEvidence(tenantId, jobIds, sinceIso)` | jobs of open gaps; floor = **earliest** `asked_at ?? created_at` across them | `sinceIso` null (no gap named a job) |
| 5 | `listCostEvents(tenantId, costJobIds)` | jobs of open `job_cost_gap` rows only | no open cost gaps |
| 6 | `listMoneySince(tenantId, jobIds, sinceIso)` | same floor as #4 | `sinceIso` null |
| 7 | `listDecisions(tenantId, open.map(n => n.id))` | this tick's gaps only | never (when gaps exist) |
| 8 | `renderLessonsBlock(tenantId)` | active lessons | wrapped in try/catch — *"a lessons-read failure must never cost the tick"* |

Reads 2 and 3 run concurrently in one `Promise.all`. Reads 4–7 are each **one batched round trip for
the whole tenant**, narrowed per gap in code — a stated discipline, repeated in each comment.

The floor for #4/#6 is bounded in practice because *"an unasked row reaches the delivery deadline
(18h) and an asked one its escalation ceiling (48h), so the floor cannot walk backwards
indefinitely"* (`planner.ts:1819-1821`).

### 4.2 Is there any notion of "what changed since the last tick"? — No.

Stated factually, from the schema and the code:

- **There is no `planner_runs` table.** The full table list holds `reflector_runs` but no planner
  equivalent. Nothing records, per firm, when the planner last ran.
- **Nothing diffs state between ticks.** Every read above is an absolute query against current state
  bounded by a gap's own timestamps. No read is bounded by "since the planner last looked".
- The closest existing thing is **per-gap, not per-firm**: `nudge_decisions.decided_at`, whose latest
  row for a gap is effectively "when the planner last considered *this gap*". Since the continuity
  phase writes an `unmentioned` row for every gap the planner was shown, that timestamp does advance
  every tick — but it is keyed by gap, exists only for gaps that were open at the time, and vanishes
  from the planner's view when the gap closes.
- `lifecycle_runs.summary->teamLeadPlanner->plans[]` carries a `tenantId` per entry and is a 90-day
  record, so "when did the planner last run for firm X" is *recoverable by query* — but nothing reads
  it that way, and it is not exposed to the planner.

**So "reconcile against the updated database" has no existing changed-since primitive to build on.**
What a tick has is the current state, plus a per-gap consideration count.

---

## 5. `tenant_profiles` and `tenant_settings` as precedent

### 5.1 The shared pattern

Both are **one row per tenant**, keyed on `tenant_id`, with the same four-part structure:

1. **A `satisfies`-pinned column map.** `STRING_COLUMNS` (`tenantProfiles.ts:44`) and
   `NUMBER_COLUMNS` (`tenantSettings.ts:73`), both
   `as const satisfies Record<string, keyof …Update>` — so a typo'd column fails `tsc` rather than
   surfacing at runtime as PGRST204.
2. **A derived field roster.** `PROFILE_STRING_FIELDS` / `SETTINGS_NUMBER_FIELDS` =
   `Object.keys(...)`. Both comments call this *"THE roster"*: the tool surface derives its accepted
   args **and** its reply echo from it, so a field added in one place is accepted, patched and echoed
   everywhere in one edit.
3. **Partial-patch semantics.** Supplied fields change; explicit `null` clears (for settings, back to
   the code default). One atomic `.upsert(..., { onConflict: 'tenant_id' })` — both files carry the
   same note that PostgREST merge-duplicates *is* the partial patch, and that
   insert-catch-23505 is the wrong idiom for a plain-PK target.
4. **Validation in the typed layer, not the tool.** Both state they are *"the single write-side guard
   for every surface"*, so an untyped caller gets an instructive error.

### 5.2 The tool surface, and how it derives its args

`set_firm_profile` (`server.ts:5684-5725`) is the worked example:

- **KEY-closed**: `const knownKeys = [...PROFILE_STRING_FIELDS, 'licenseNumbers']`, and any unknown
  key is **refused**, not dropped. The comment names the failure it prevents: with `required: []`,
  a call made entirely of misspelled keys would otherwise flip into the no-field read mode and the
  manager would be told the profile was saved.
- **No-fields = a read.** `Object.keys(patch).length === 0` returns the current profile without
  writing — *"the echo IS the get — no separate get tool."*
- The reply echoes `profileEcho(saved)` plus `profileGaps(saved)`.

`tenant_settings` has **no tool surface at all** today — the roster export exists (`"any future tool
surface derives its accepted args from SETTINGS_NUMBER_FIELDS"`) but nothing consumes it.

### 5.3 `readSettingsTolerantly` — the newest pattern, and the argument behind it

`tenantSettings.ts:200-237`. `getTenantSettings` **throws** on a missing relation; the tolerance is a
separate, explicitly-named function returning `{ settings, tableMissing }`. Two reasons are recorded:

- `42P01`/`PGRST205` names *a* relation, not *this* one — the safety of swallowing it rests entirely
  on the query being **embed-free**, and *"a rule whose correctness depends on nobody editing the line
  above it is not a rule."*
- *"An accessor that swallows cannot REPORT."* The `tableMissing` flag exists so the caller can put
  it in a summary (`WatchersSummary.settingsTableMissing`, `PlannerSummary.settingsTableMissing`).

`resolveSettings` is the one place defaults are applied, and it deliberately does **not** default the
hours pair: *"unset must never mean 'think less about this firm'."* A half-set or non-forward pair
normalises to null rather than defining a broken window downstream.

### 5.4 Where a filesystem-shaped store would have to differ

Stated as differences in kind, not as a design:

| Property | `tenant_profiles` / `tenant_settings` | what "memory as .md files" implies |
|---|---|---|
| Cardinality | exactly one row per tenant, PK `tenant_id` | many rows per tenant, keyed by `(tenant_id, path)` — the PK is no longer the tenant |
| Column model | fixed typed columns, `satisfies`-pinned to the generated type | free text; the `satisfies` pin has no analogue, because the *content* is not a schema |
| Arg roster | a closed key set derived from the column map; unknown keys refused | a path is an open string — there is no roster to derive, so the KEY-closed refusal has nothing to close over |
| Writer | a human, through a manager-tier MCP tool, or code | **the model**, through a tool the planner calls |
| Validation | per-field (state code format, license entry shape, integer hours) | per-*document*; the only existing analogue is `cleanLessonText` |
| History | none — an upsert overwrites | versioning is called for (a bad overwrite must be recoverable) |
| Patch semantics | field-level partial patch; `null` clears | file-level replace vs. append vs. edit is an open question with no precedent here |
| Prompt exposure | `tenant_profiles` reaches documents; settings reach code only | content reaches the planner's prompt — inheriting `planner_lessons`' prompt-injection property (§1.1) |

The `readSettingsTolerantly` pattern transfers directly: a new table on an unmigrated database should
be a reportable condition, not a crash.

---

## 6. Auditability, the L1 rule, and the date rail

### 6.1 How the planner's existing writes are recorded

Every decision the planner makes becomes a `nudge_decisions` row, written **after** the write is
attempted, never before — `planner.ts:1971-1974`: *"recording first would log an intention as an
outcome, and the whole reason this table exists is that 'the planner decided X' and 'X happened' had
become indistinguishable."*

`NudgeDecisionInput` (`nudgeDecisions.ts:11`) carries `tenantId`, `nudgeId`, `jobId`, `mode`
(`shadow`|`live`), `action`, `notBefore`, `escalateAfter`, `handoffNote`, plus `confidence`, `reason`,
`outcome` (`applied`|`refused`|`shadow`) and `outcomeDetail`. Three sources feed it: applied
decisions, rail-refused decisions, and `unmentioned` tick-marks for every gap in the view that
neither list named.

So the planner's audit trail is **per-gap and outcome-bearing**. A memory write has no gap to hang
off, and therefore no row in this table.

### 6.2 The L1 obligation, and whether a memory write falls under it

CLAUDE.md's recorded exception of 2026-07-04 makes **outbound/agent-action captures classifier-free**
and states the scope precisely:

> every send via the spine `send_email` tool and every state-changing Composio execution ingested by
> `src/composio/logIngest.ts` is captured with NO work/personal gate.

The rationale given is that *"an outbound action is something the agent performed on the business's
behalf; the audit record matters most exactly when the action was personal or inappropriate."*
`logIngest.ts` implements the Composio half: sends are stored verbatim; conservative read-only slug
prefixes are skipped; **anything that matches nothing and is not a send is captured** ("when unsure,
capture"); non-send captures store **argument key names only, never values**, because L1 is
undeletable.

Factually: **a planner memory write matches neither clause.** It is not a `send_email`, and it is not
a Composio execution — it never leaves the process, so `logIngest` cannot see it. No existing capture
path would record it. Whether it *ought* to be captured is not answered by the existing rule; what the
rule does establish is the standard the question is judged against — *is this something the agent
performed on the business's behalf that a later reader would need to see?* — and the
keys-only-redaction precedent for content that cannot be deleted once written.

### 6.3 The date rail, and "a memory is a rule, not an event"

Two separate rails exist, and `lessons.ts:24-27` explicitly says one is the wrong tool for the other:

- **`cleanPlannerText`** (`planner.ts:973`) — the *allowed-strings* rail. A handoff note or
  `agentContext` may contain **only** the date labels the gap listed (`dateLabels`, built at
  `planner.ts:704` from `askedLabel`, `dueLabel`, `agoLabel` and printed under *"dates you may use in
  a handover note, VERBATIM and only these"*). Anything else and the note is discarded. This works
  because the permitted vocabulary is *served to the model in that gap's own block*.
- **`cleanLessonText`** (`lessons.ts:34`) — the *refuse-absolute-dates* rail. Weekday and
  time-of-day words are **allowed** ("Friday evening" is the content); `\d{4}-\d{2}-\d{2}` and
  month-and-day patterns are refused. The comment states why the first rail cannot be reused: *"it
  only admits served date labels, and a lesson legitimately has none."*

That second rail **is** the entire implementation of "a memory is a rule, not an event". It is the
one piece of the lesson machinery whose reasoning is about *memory as a category* rather than about
lessons as a workflow — and deleting `lessons.ts` deletes it.

Note also `REFLECT_SYSTEM`'s companion clause, which has no code behind it: *"Never include a
person's private details."* That is prompt-only; no rail enforces it.

---

## External dependencies

- **The inference provider**, reached through `runForcedTool` / `runToolLoop` (OpenRouter today,
  `MODEL_PROVIDER=openai`). The Reflector spends one call per eligible firm per day; the planner
  spends one conversation per firm per tick.
- **Supabase/PostgREST** for every table above. RLS + `revoke all from anon, authenticated` on both
  `planner_lessons` and `reflector_runs`, load-bearing because their content reaches a prompt.
- **Composio**, only indirectly — `logIngest.ts` is the outbound capture path referenced in §6.2.

## Constraints and invariants

1. **Anything whose text reaches the planner's prompt is a prompt-injection surface.** Stated in the
   `planner_lessons` migration as the reason RLS and the revoke are load-bearing beyond convention.
2. **`flatten` on every DB → prompt crossing.** `reflector.ts:104-112` names the attack: embedded
   newlines forging corpus lines or a fake ACTIVE section. Applied at render time because
   append-only rows already hold raw text.
3. **Deny-by-default in both directions.** `TEAM_LEAD_TOOL_NAMES` caps what a `spine:` identity may
   dispatch; `TEAM_LEAD_ONLY_TOOL_NAMES` refuses those same tools to every non-`spine:` badge. A tool
   must be added to both the allowlist and the schema array to be usable, and to neither to be
   invisible.
4. **The model proposes, code disposes.** `submit_plan` returns a plan; every rail is re-checked and
   every action performed by code after the loop returns.
5. **Record after the write, never before.** `nudge_decisions` exists because intention and outcome
   had become indistinguishable.
6. **L1 is undeletable**, so the redaction policy is *"the one thing standing between 'audit' and 'we
   stored something we can never delete'"* — keys-only for non-send captures.
7. **`src/db/` is an import leaf.** No production module under it imports from `src/jobs/`,
   `src/teamLead/` or `src/control/` — the stated reason the build-2 defaults moved *down* into
   `tenantSettings.ts` rather than being imported up from `watchers.ts`.
8. **The lessons block is bounded at activation, not at render.** There is no overflow path, because
   overflow is unreachable — the human is refused instead.
9. **A retired lesson is terminal**; a stale one is still activatable by explicit id.
10. **The planner is stateless across ticks.** `runToolLoop` calls `transport.initialHistory()` every
    call; nothing persists the message array. Continuity is `nudge_decisions` + the lessons block.

## Decision points

1. **"Reconcile first": doctrine or a code-enforced phase.** Doctrine means a paragraph in
   `PLANNER_SYSTEM` and nothing else — consistent with §6a's principle that the planner decides what
   to do, and with the fact that prompt rules here are *"steering, never enforcement"*. A code-enforced
   phase means either a second loop before the planning loop (a second model call per firm per tick,
   doubling the fixed ~6.4K-token floor) or an ordering constraint inside one loop, which the tool
   loop has no mechanism to express today — it has a *terminal* tool but no *prerequisite* one.

2. **There is no changed-since primitive to reconcile against (§4.2).** Reconciliation can be
   (a) unconditional — the planner re-reads and re-judges its memory every tick, at whatever token
   and latency cost that carries; or (b) conditional on something that does not exist yet, which
   means build 3 also builds the marker (a `planner_runs`-style row, or a `last_reconciled_at` on the
   memory store). Option (b) is the only one that can answer "has anything moved since my last
   write?", which is the churn question below.

3. **What stops 48 rewrites a day.** Nothing in the current design would. The existing analogues are
   all *human-gated* — activation refuses at the budget, striking is manual, the Reflector fires at
   most once per firm per day behind four gates. Every one of those brakes is on the *human* or on a
   *daily cadence*; none of them transfers to a model writing inside a 30-minute tick. The options
   visible in today's code are a cadence gate (the Reflector's shape), a size budget enforced at write
   time rather than at activation (the inverse of §1.4), or a changed-since gate (which needs
   decision 2).

4. **What stops reconciliation crowding out planning.** Build 1b removed the turn ceiling, so the
   only rail is the 15-minute clock and there is no mechanism to reserve part of it for the planning
   half. The planner cannot see the clock (build 1b, user choice: deferred to build 6). Whatever
   reconciliation costs comes straight out of planning, unobservably to the model.

5. **What the first write verb must satisfy.** The gate's stated rule is *"nothing irreversible or
   externally visible may ever dispatch for it"*. A memory write is neither — but §2.3 shows the
   novel property is different: it would be the first model call that mutates durable state **inside**
   the loop, with no post-loop validation stage. Whether the rule's wording covers that, or whether the
   rule is about *reach* (nothing leaves the firm) rather than about *when validation happens*, is
   the question. Mechanically, the verb needs entries in **both** `TEAM_LEAD_TOOL_NAMES` and
   `TEAM_LEAD_TOOLS`, and the second one costs prompt tokens on every tick forever (§3.2).

6. **Whether the Reflector survives, and against what.** Its stated future is already written down —
   the CLI's interface *"is deliberately the future adversarial judge's interface"*. If the planner
   writes its own memory, the Reflector's *authoring* role is gone; its *auditing* role has no
   subject unless the memory store is what it reads. Note that today it reads `gap_summaries`, not
   lessons, so an auditor of memory is a different program from the one that exists. Deleting it
   orphans the list in §1.8, including `REFLECTOR_MODE` and both its migrations.

7. **What happens to the LESSONS paragraph in `PLANNER_SYSTEM`.** It has never described anything
   the model was shown (§1.6) and is billed on every turn. It can be deleted with the lessons
   machinery, or rewritten to describe the new store. Doing neither leaves ~9 lines of doctrine
   pointing at a system that no longer exists.

8. **Whether `cleanLessonText`'s rail survives its file.** It is the only implementation of "a memory
   is a rule, not an event", and it is deliberately *not* the same rail as the planner's allowed-dates
   check — the two answer different questions (§6.3). If `lessons.ts` is deleted, that rail is either
   carried over to the new store or the property is dropped.

9. **Whether a memory write is captured, and where.** No existing path would record one (§6.2):
   `nudge_decisions` is per-gap, and `logIngest` only sees Composio executions. The choices are the
   cost-event trail it gets for free from `dispatch` (tool name only, no content), a versions table
   (which the direction already anticipates), L1, or nothing.

## Open questions

- **What the provider actually counts as input tokens.** The measured 6,529-token turn-1 input for a
  one-gap tick sits almost exactly on the ~6,452-token fixed floor computed from
  `PLANNER_SYSTEM` + schema JSON at 4 chars/token (§3.2), leaving implausibly little for the user
  message. Resolving this needs a real tokenisation of a captured request body, not arithmetic — and
  it matters, because "the index is in every prompt" is a decision about a budget nobody has measured
  precisely.
- **Whether `get_customer_context` and `resolve_date` are intended to be reachable by the planner.**
  They are on the allowlist and absent from the schemas (§2.2). This document records the state; it
  cannot tell from the code whether that is drift or deliberate.
- **Whether `REFLECTOR_MODE` is set anywhere on the pilot.** One `reflector_runs` row exists, so it
  has run at least once, but the env var's current value is not readable from the repo.
- **What the three `proposed` lessons on the pilot say**, and why none was activated — whether they
  were reviewed and rejected, or simply never looked at. The store cannot distinguish those: there is
  no "reviewed and declined" status, only `proposed` until 60 days make it `stale`.
- **Whether one Reflector run's output was among those three proposals.** `reflector_runs.proposed`
  records a count per run; the lessons themselves carry no run id, so the join does not exist.
