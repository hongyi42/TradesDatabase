---
date: 2026-08-19
task: Make the nudge ladder multi-kind, add a minimal cost store, and land cost-chasing as detector #2
research: thoughts/shared/research/2026-08-19-nudge-pacing-planner-and-cost-detector.md
status: draft
---

## Overview

Plan **A** of two. It makes the team-lead ladder carry more than one kind of question, adds the
smallest cost store that lets a cost question be detected, and registers cost-chasing as
detector #2 — with the per-detector runaway brake the deleted per-person cap used to provide
incidentally.

Plan **B** (written after this lands) is the pacing planner: declared urgency tiers, deterministic
SQL modifiers, batching by carrier/rider. It is deliberately unplanned — it needs a real
two-detector tree, which this plan produces.

## Decisions

- **Two plans, foundation first** — *user choice*. B gets designed against two real gap kinds.
- **Minimal cost store, not the full ledger** — *user choice*. One new `money_event_kind` so a cost
  gap is detectable. Labor-rate table and margin surface out of scope. This records *material*
  cost only — **never describe it to a user as margin or profitability**.
- **`material_cost` as the enum value** — permanent (Postgres cannot remove enum values). Chosen
  over `job_cost` (collides with `cost_events`, our unrelated *vendor API spend* table).
- **Once-ever dedup, limitation accepted** — *user choice*. Cost subject is the **jobId**, so only
  the FIRST cost gap on a job is ever asked. Later purchases on a multi-day job are never chased.
  Taken to keep "ask once, ever" a database guarantee. Asserted by a test so it reads as a
  decision, not an oversight.
- **The nudge closes when the TECHNICIAN answers, not when money is recorded** — *user choice
  (option 1)*. Forced by a blocker the plan review caught: `record_money_event` is manager-only
  (`server.ts:1909`, and `:1905` caps the team-lead identity outright), so the technician's agent
  cannot create a cost event. Resolving on the cost event would leave every cost nudge running to
  the 48h escalation and then telling the manager a technician "hasn't heard back" *after they
  answered*. Resolve on job activity instead — the same predicate the visit detector uses.
- **Detector ships first; the fill pipeline is a LATER plan** — *user choice*. Consequence stated
  plainly: the technician's stated amount is captured as **prose only** (L1 capture + visit
  record). `ExtractedFields` (`extract.ts:8-24`) has no money field and the prompt says "never
  invent … prices", so nothing lifts the number out. **A cost figure becomes countable only when a
  manager manually records it.** Plan C owns extractor capture → staged `pending_job_cost` →
  one-tap confirm.
- **Costs are new KINDS in `money_events`, never a separate table** — *standing user constraint
  2026-08-19*: business analytics must stay possible, so money's structure is load-bearing. New
  kinds inherit the not-null job FK, the joined view, the job-keyed accessors and negation
  semantics; the fold is kind-additive so they are provably inert in revenue math. **Analytics
  rule to preserve: aggregate the SUMMARIES (`summarizeMoney` per job), never the rows.** See
  `docs/engineering-memory.md` §5.
- **Registry, not a switch** — the hardcoded `'overdue_visit_gap'` filters become one registry.
  The dangerous filter (the resolve sweep) fails *silently*: an unregistered kind is never swept.
- **`filled`/`moot` are pure functions over pre-fetched facts** — they take a facts object, never a
  DB client, so the sweep keeps its ONE batched fetch (`watchers.ts:308-341`).
- **Handoff builds a plan; watchers performs it** — specs return a `HandoffPlan`, so the injected
  `flagGap` seam every test relies on stays intact.
- **Prompt text moves to `nudgeKinds.ts`; it is not imported from `compose.ts`** — review finding:
  `compose.ts:11` already imports `wallClockLabel` from `watchers.ts`, and having `nudgeKinds.ts`
  read `const COMPOSE_SYSTEM` back out of `compose.ts` creates a module-init cycle that throws
  `ReferenceError` (TDZ) on any import of `compose.js`. Phase 1's cycle is safe only because
  `wallClockLabel` is a hoisted `function`.
- **Detection anchors on ASSIGNMENT END, not job status change** — review finding: no job-status
  history exists; `jobs.updated_at` is bumped by any write and is real-UTC while the watcher's
  window is naive-local. Reusing the assignment-end window also supplies the technician to ask and
  bounds the first-run backfill.

## Plain-language walkthrough

The assistant can ask exactly one kind of question today, and that kind is written as a literal
piece of text in four separate places. Adding a second is not "write a second detector" — it is
widening those four spots, and one of them (deciding when a question is finished) would *silently*
ignore a new kind, leaving it open forever.

```
        BEFORE                               AFTER
  ┌──────────────────────┐            ┌──────────────────────────────┐
  │ watcher  "overdue…"  │            │ watcher   for kind of KINDS  │
  │ sweep    "overdue…"  │            │ sweep     for kind of KINDS  │──► registry
  │ compose  "overdue…"  │            │ compose   for kind of KINDS  │    ├ overdue_visit_gap
  │ flagger  "overdue…"  │            │ flagger   takes a kind       │    └ job_cost_gap (new)
  └──────────────────────┘            └──────────────────────────────┘
```

**Phase 1** turns the watcher-side literals into a registry: each kind declares how to tell it's
answered, when it's moot, and how many may be raised per firm per tick (the runaway brake). Only
the existing kind is registered — you'd notice it working by the suite staying green.

**Phase 2** does the same for the message-writing side, which today has one prompt hardwired to
visits. Still one kind; still no behaviour change.

**Phase 3** adds one new entry to the money ledger's vocabulary, `material_cost`. The ledger's
maths is per-kind, so a cost row contributes to nothing that exists — invoices, balances and job
status are untouched. You'd notice it working by recording a cost and seeing balance due not move.

**Phase 4** registers the real second detector: a finished job with no cost recorded asks the
technician who worked it. Their answer is saved as words on the job and closes the question. It
does **not** become a countable number — a manager still has to record that, and nothing chases
them yet. That gap is Plan C, and it is the honest limit of this plan.

**Phase 5** proves it live, because this subsystem once passed every test and still failed 100% in
the field — every test used a single-line message and the real transport rejects newlines.

## Secrets & env preflight

- **Phases 1–4:** none.
- **Prerequisite for every phase:** this worktree has **no `.env.test`** — run
  `scripts/second-stack.sh 3` inside it once, or `npm test` cannot run at all. (Review finding.)
- **Phase 5:** `WATCHERS_MODE=live` + `NUDGES_MODE=live` on the Render **cron** service
  (`already required`); model credentials for compose (`already required`). No new secret. A
  Render env change reaches scheduled runs only after a **deploy**, and Render deploys from the
  fork `Yu-C1/TradesDatabase` — merging on `origin` deploys nothing.

## Phase 1: Make the watcher side kind-pluggable

### What this phase does
Replaces the watcher-side hardcoded kind with a registry, adds the per-detector brake, and makes
the manager-handoff flagger kind-generic. One kind registered; behaviour unchanged.

### Changes required

**`src/jobs/nudgeKinds.ts`** (new)
- `SweepFacts` — `{ hasActivitySince(jobId, sinceLocal): boolean; visitStatusById: Map<string,string>; jobStatusById: Map<string,string> }`. `jobStatusById` is included **now**, unused by the overdue spec, because Phase 4's `moot` needs it (review finding 10).
- `HandoffPlan` — `{ subjectRef, jobId, technicianRef, startsAtLocal, endsAtLocal, suggestion }`.
- `NudgeKindSpec` — `{ kind: ReviewKind; maxNewPerTenantTick: number; filled(n, f): string|null; moot(n, f): string|null; handoff(n, mode: 'escalated'|'expired', naiveLocal: (utc: string) => string): HandoffPlan|null }`. The `naiveLocal` parameter is required: the escalation copy calls `wallClockLabel(naiveLocal(asked_at))` and `naiveLocal` is a **per-tenant closure** built at `watchers.ts:251` (review finding 4).
- `OVERDUE_VISIT_GAP_SPEC` lifting today's logic verbatim, `maxNewPerTenantTick: 5`.
- `NUDGE_KIND_SPECS`, `NUDGE_KINDS: ReviewKind[]`, and `specFor(kind: string): NudgeKindSpec | undefined`.
- Move `stage0Suggestion` (`watchers.ts:148`) here and **export** it — `watchers.ts:631` still calls it directly for the fresh-gap fallback, which has a `PlacedAssignment`, not a `Nudge`. Also replace the byte-identical duplicate at `compose.ts:198-202` with a call to it (review finding 18).

**`src/db/reviewItems.ts`**
- Add `flagNudgeGap(input)` — the body of `flagOverdueVisitGap` (`:141-175`) with the kind literals at **`:157`** (pre-check) and **`:164`** (upsert) taking `input.kind`. `startsAtLocal`/`endsAtLocal` become **optional** — a job-scoped cost gap has neither (review finding 11).
- Keep `flagOverdueVisitGap` as a wrapper delegating with `kind: 'overdue_visit_gap'`, so its ~25 existing stub sites are untouched.

**`src/jobs/watchers.ts`**
- `:154-174` `WatcherDeps` — add `specs?: NudgeKindSpec[]`, defaulting to `NUDGE_KIND_SPECS`. Without this seam the brake test cannot register a second kind (review finding 9).
- `:295` — replace the kind filter with `specFor(n.kind) !== undefined`; keep rows whose kind is unregistered **out of the sweep but logged once per tick** so the "silently stranded" failure is visible. (Resolves review finding 8: filter and log in one place, not two.)
- `:417-458` — resolve the spec per row; call `spec.filled` then `spec.moot`, preserving today's precedence.
- `:464-502` / `:511-556` — replace inline copy with `spec.handoff(x.n, 'expired'|'escalated', naiveLocal)`; a `null` plan keeps today's freeze-and-log behaviour. Route through `flagNudgeGap` with the spec's kind.
- `:564` — **the brake replaces the slice per kind, and the tenant-wide ceiling still holds.** Compute `top` per kind as `fresh.slice(0, spec.maxNewPerTenantTick)`, then cap the combined created-this-tick count at `MAX_NEW_ITEMS_PER_TENANT_TICK`, oldest-first across kinds. This keeps the tenant surge brake at 5 (not 5+3) while stopping one kind starving the other (review finding 7).
- `:598` — kind comes from the spec being routed.
- `:176-197` `WatchersSummary` — `gapsFound`/`freshGaps`/`nudgesWouldCreate` are visit-shaped. Add `byKind: Record<string, { gapsFound: number; nudgesCreated: number }>` and leave the existing fields meaning what they mean today (review finding 7).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm run build` pass
- [x] `npm test` passes with **no pre-existing test changed** — 1787 → 1792, the five new tests only
- [x] new test: a nudge whose kind has no spec is neither resolved, escalated, nor expired, and logs
- [x] new test: the per-kind brake caps creation below the tenant ceiling
- [x] new test: **creation is registry-gated** — an unregistered kind is never minted (added after review finding B: stranding was possible from the CREATE end too)
- [x] new test: the tenant ceiling still caps the tick when a kind brake is higher
- [x] new test: escalation copy is byte-identical to today's for `overdue_visit_gap`

**Deliberate deferrals, recorded so Phase 4 does not rediscover them:**
- `WatchersSummary.byKind` — deferred to Phase 4. With one kind it adds nothing and forced churn in
  `lifecycle.test.ts` stubs that build a full summary literal.
- Handoffs still route through the existing `flagGap` dep, not `flagNudgeGap`. `flagNudgeGap` exists
  and `flagOverdueVisitGap` wraps it, but switching the injected dep re-types ~25 stub sites that
  read `input.assignmentId`. **Phase 4 must wire it** — a cost handoff has no visit window and is
  currently logged-and-skipped at `watchers.ts:487`/`:535`.
- `deps.specs` cannot exercise cross-KIND brake independence until a second kind routes (Phase 4);
  the brake test asserts what it can actually prove today.

### Live verification (agent-executable)
- Prerequisites: none — behaviour-preserving, fully covered by unit tests.

### Manual verification
- none

---
*No manual items — continue.*

## Phase 2: Make the compose side kind-pluggable

### What this phase does
Gives each kind its own prompt, context reader and assembler.

### Changes required

**`src/teamLead/composeCopy.ts`** (new)
- Holds `COMPOSE_SYSTEM`, `COMPOSE_TOOL`, `buildOverdueUserPrompt`, and the footer assembler,
  moved out of `compose.ts`. **This module is why Phase 2 does not deadlock**: `nudgeKinds.ts`
  imports from here, never from `compose.ts` (review finding 3).

**`src/jobs/nudgeKinds.ts`**
- Extend `NudgeKindSpec` with `compose: { system; tool; prepare(n, nowIso, tz) }`, wired to `composeCopy.ts` for the overdue kind. **`prepare` returns a CLOSURE** — `{ user, assemble }` — so the row's context never escapes the block. This replaces the planned `{buildUser, readContext, assemble}` triple and the `ComposeContext | CostComposeContext` union: a second kind can carry a completely different context shape with no union and no generic leaking into the registry, which is what the union was working around.

**`src/teamLead/compose.ts`**
- `:288-290` — filter on `specFor(n.kind)`; resolve the spec inside the loop at `:299`.
- `:301-350` — call `spec.compose.prepare(...)` and `prepared.assemble(...)` instead of module-level functions.
- Keep `readComposeContext`, `assembleNudgeMessage`, `relativeDayPhrase` exported — `nudgeQueue.ts:11` and `compose.test.ts` import them (re-exported from `composeCopy.ts`).

**MOVED TO PHASE 4 — the terminal-write gating.** The plan originally put three gates here
(compose's decline path, and `nudgeQueue.ts`'s serve-cap and delivery-give-up paths), so a row
whose gap reached no manager surface would not be closed. They were implemented, reviewed, and
**reverted**, because with a visit-shaped kind they are unreachable-but-harmful:
- Gating the decline freezes the row **after** the model call, so an unflaggable row is
  re-composed — a fresh paid call — every tick forever, with no exit (the 24h expiry sweep
  refuses the same row for the same missing fields). ~144 billed calls/day.
- Gating the serve cap removes the only terminal exit a queued row has: never re-served, but
  never closed, so every 5-minute pull re-reads it and logs.
- `handToManager` returns `false` for BOTH "flag failed" and "already flagged" — `flagNudgeGap`
  returns null by design on the once-ever dedup — so the gates refuse to close rows the manager
  already has.
Phase 4 owns these gates, and must land them with the two things that make them safe: a flagger
that distinguishes *created* from *already present*, and a bounded exit for a row no surface can
accept.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm run build` pass
- [x] `npm test` passes; no pre-existing test changed — 1792 → 1795
- [x] new test: two injected specs compose with different `system` text AND assemble their own deliverable
- [x] new test: a kind with no spec is never composed
- [x] new test: delivery give-up with a LANDED handoff still closes the row `failed` (regression lock)
- [x] ESM cycle proven safe by importing each of `compose`, `composeCopy`, `nudgeKinds`, `watchers` FIRST against the built output — no TDZ error from any entry direction
- [x] moved copy verified byte-identical against `git show HEAD:src/teamLead/compose.ts`
- ~~new test: `completeNudgeDelivery` with a failing handoff leaves the row queued~~ — gating moved to Phase 4
- ~~new test: a declined compose whose handoff fails leaves the row pending~~ — gating moved to Phase 4

### Live verification (agent-executable)
- Prerequisites: none — behaviour-preserving.

### Manual verification
- none

---
*No manual items — continue.*

## Phase 3: The minimal cost store

### What this phase does
Adds `material_cost` and proves it is inert everywhere revenue is computed.

### Changes required

**`supabase/migrations/<ts>_material_cost_kind.sql`** (new — this statement and nothing else)
- `alter type money_event_kind add value if not exists 'material_cost';`
- Follows the house precedent at `20260723090000_promise_time_only_value.sql:6-13`: the value
  cannot be *used* in the transaction that adds it, so dependent DDL goes in a companion file.
  (Reviewer confirmed local Postgres is 17 and this form is valid.)

**`src/db/database.types.ts`**
- **Regenerate.** `MoneyEventKind` derives from this file (`moneyEvents.ts:7` →
  `database.types.ts:2119-2131`, plus the `Constants` array at `:2302-2315`), so Phase 3 does not
  compile without it. Apply the migration locally, then `npm run gen:types:local`. **Never
  `npm run gen:types`** (`package.json:20`) — that is `--linked`, i.e. the pilot's live DB.
  (Review finding 1.)

**`src/db/moneyEvents.ts`**
- Add `'material_cost'` to `MONEY_EVENT_KINDS` (`:11-24`). Not amountless, not negating — an amount
  is required, and `AMOUNTLESS_KINDS`/`MUST_REFERENCE` are untouched.
- `MoneySummary` (`:210-223`) gains `materialCostCents`; `summarizeMoney` (`:246-289`) adds
  `materialCostCents = sum('material_cost')`. **`balanceDue` (`:285`) is unchanged** — cost is not
  an AR number.
- `deriveStatusTarget` (`:301-334`) — no change (its gate is `invoice_issued`-only). Locked by test.
- Leave `technicianMoneyView` (`:400-404`) as-is: cost is **not** technician-visible.

**`src/mcp/server.ts`**
- `:1370-1385` — one line in `record_money_event`'s description: `material_cost` is what the job
  COST the firm, never what the customer owes; it never affects balance due or job status. The
  `kind` enum spreads automatically from `MONEY_EVENT_KINDS` (`:1391-1394`).
- `:1090-1094` — extend the `v_money_events` paragraph in `query_spine`: direction is by kind, and
  `material_cost` is a COST row, so `sum(amount_cents)` across kinds is meaningless. **This is the
  text the analytics constraint hangs on.**
- `:2244-2288` (`get_job`) and `:2207-2225` (`get_customer_context`) — both surface
  `summarizeMoney` to managers, so both now show `materialCostCents`. Label it so it cannot be
  mistaken for revenue or margin (review finding 14).

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` pass
- [ ] `npm test` passes
- [ ] new test: appending `material_cost` leaves `invoiced`, `paid`, `balanceDue`, `quoted` byte-identical and populates `materialCostCents`
- [ ] new test: `deriveStatusTarget` returns the same target with and without a cost event
- [ ] new test: `correction` targeting a `material_cost` row negates it out of `materialCostCents`
- [ ] new test: `technicianMoneyView` output is unchanged by a cost event
- [ ] `npx supabase db reset` applies the migration cleanly on a fresh local stack

### Live verification (agent-executable)
- Prerequisites: local stack only. **Never the hosted "test" project — that is the pilot's live
  database**, and `money_events` is append-only, so a stray row is permanent.
- [ ] Record a `material_cost` locally via the MCP tool path; read back through `v_money_events`
      and capture the row plus the unchanged balance.

### Manual verification
- none

---
*No manual items — continue.*

## Phase 4: Register cost-chasing as detector #2

### What this phase does
Adds the second kind end to end: detection, spec, prompt, resolve, brake.

### Changes required

**`src/db/reviewItems.ts`** — add `'job_cost_gap'` to `ReviewKind` (`:10-59`). Columns are plain
`text`; no migration.

**`supabase/migrations/<ts>_job_cost_gap_ever_index.sql`** (new)
- `create unique index uq_review_items_job_cost_gap_ever on review_items (tenant_id, subject_ref) where kind = 'job_cost_gap';`
- Mirrors `uq_review_items_overdue_gap_ever` (`20260817090000_nudges.sql:76-78`). Without it the
  new kind keeps only the app-level select-then-insert (`reviewItems.ts:153-161`), which
  double-flags under a race — the exact hole that index closes (review finding 15).

**`src/db/jobs.ts`**
- `listCostGapCandidates(tenantId, endedFromNaive, endedToNaive)` — jobs whose most recent
  **confirmed assignment** ended in the naive-local window (same bounds as
  `listOverdueConfirmedAssignments`, `assignments.ts:533-547`), whose `status` is `completed` or
  `invoiced`, returning job id, title, customer name, and that assignment's `technician_id`.
  **Rows with a null `technician_id` are dropped** — it is nullable since
  `20260717120000_technician_optional_bookings.sql:15`, and `createPendingNudge` requires a
  non-null technician (`nudges.ts:29`) (review finding 6).

**`src/db/moneyEvents.ts`** — `listJobIdsWithCostEvents(tenantId, jobIds)`, `in()`-bounded (the
`listNudgedSubjectRefs` shape, never a tenant scan).

**`src/jobs/nudgeKinds.ts`** — `JOB_COST_GAP_SPEC`: `kind: 'job_cost_gap'`;
`maxNewPerTenantTick: 3`; `filled` = **activity on the job since the ask** (the user-chosen close
rule — *not* the presence of a cost event); `moot` = `jobStatusById` says `cancelled`;
`handoff` = manager copy naming the job and asking for its material cost, with no
`startsAtLocal`/`endsAtLocal`. Its compose block asks what the job cost in parts/materials, keeps
the ban on inventing prices, and does **not** ask the technician to compute a total.

**`src/teamLead/compose.ts` + `src/control/nudgeQueue.ts`** — land the terminal-write gating
deferred from Phase 2 (see that phase for why it could not ship alone). Required together:
1. `handToManager` gains a `kind` parameter and calls `flagNudgeGap`, so a job-scoped gap reaches
   the manager at all (Phase 1 deferred this: the handoff loops still use the visit-shaped
   `flagGap` dep and log-and-skip a plan with no visit window, at `watchers.ts:487`/`:535`).
2. The flagger must report *created* vs *already present* distinctly — `flagNudgeGap` returns null
   for both today, and the once-ever dedup makes "already present" the common case.
3. A bounded exit for a row no surface can accept, so gating cannot strand it or re-pay for model
   calls every tick.

**`src/jobs/watchers.ts`**
- `WatchersSummary` — add the `byKind` breakdown deferred from Phase 1; the flat
  `gapsFound`/`freshGaps`/`nudgesWouldCreate` counters are visit-shaped and a second detector
  would otherwise pollute them.
- `WatcherDeps` (`:154-174`) — add `listCostCandidates?` and `listCostEvents?`, defaulted in tests'
  `baseDeps` (`watchers.test.ts:64-86`), or the ~40 existing watcher tests start issuing real DB
  reads (review finding 10).
- Add the cost detection pass: candidates → drop ever-flagged / ever-nudged (`listEverFlagged` /
  `listNudged` already take a kind) → route through the shared reachable/brake/create path.
- Populate `jobStatusById` and `jobHasCostEvent` in the existing batched pre-fetch (`:308-341`),
  never per row.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` pass; `npm test` passes
- [ ] new test: a completed job with no cost event produces a `job_cost_gap`; a field note on that job closes it `answered` next tick
- [ ] new test: **once-ever is real** — after the first cost nudge on a job resolves, a second cost gap on that job creates nothing
- [ ] new test: both kinds open for one technician, each resolving independently on its own predicate
- [ ] new test: a `job_cost_gap` asked 49h ago escalates with cost copy and an `escalatedFromNudge` link
- [ ] new test: a candidate job whose assignment has a null `technician_id` creates no nudge and throws nothing
- [ ] new test: a cost gap that fails delivery reaches the manager (the Phase-2 `nudgeQueue` fix, exercised with a real cost context)

### Live verification (agent-executable)
- Prerequisites: local stack; `npm run seed:local`.
- [ ] Seed a completed job with no cost event, run `runWatchers` live, read back the `nudges` row —
      capture `kind`, `subject_ref` (**must be the jobId**), and `context`.

### Manual verification
- [ ] Read the composed cost question. It must not imply an audit, must not ask for arithmetic, and must make "nothing to report" comfortable.

---
*Pause after this phase — the copy check is user-facing.*

## Phase 5: Live end-to-end

### What this phase does
Proves both kinds deliver on the real system. Stage 1 passed six review rounds and 1789 tests
while delivery failed 100%, because every test used a single-line message and the transport
rejects newlines (`nudge-runner.sh:132-141`).

### Changes required
None — verification only. Defects are fixed in the phase they belong to.

### Automated verification
- [ ] Full gates green on the merged branch before deploying

### Live verification (agent-executable)
- Prerequisites: ssh `trades-box-1`; Supabase MCP on the pilot (**read-back only**);
  `NUDGES_MODE=live` deployed **to the fork** `Yu-C1/TradesDatabase`; a reachable seat.
  **Compose is gated to 7am–7pm firm-local — this cannot run outside that window.**
- [ ] A real `job_cost_gap` composes, queues, delivers, lands `asked`. Judge by the session
      **trajectory**, never CLI stdout.
- [ ] Reproduce the real multi-line payload — do not hand-craft a single-line message.
- [ ] Read back `nudges`: `serve_count`, `asked_at`, `status`.
- [ ] A technician reply resolves the cost nudge `answered` via the activity predicate.
- [ ] Confirm the reply's stated amount is visible as prose on the job and that **no** money event
      was created — the known, accepted limit this plan ships with.

### Manual verification
- [ ] The delivered cost question reads as a colleague's question on a real phone, no operator
      jargon. Stage 1 closed with this item still open for the visit question, so the copy is
      genuinely unproven.

---
*Pause after this phase — manual and user-facing.*
