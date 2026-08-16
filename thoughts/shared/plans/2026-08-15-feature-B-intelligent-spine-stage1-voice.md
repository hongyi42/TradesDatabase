---
date: 2026-08-15
rebased: 2026-08-16 — onto landed Feature A (PR #147, a0a9fd0), per the plan-two STACK verdict
task: "Feature B — Intelligent spine Stage 1 (the voice): team-leader outreach through the person's own agent, capped identity class, server-side nudge budget/dedup/escalation"
research: thoughts/shared/research/2026-08-15-feature-B-intelligent-spine-stage-1-team-leader-voice.md
approved: 2026-08-16 — decision brief ratified by the user with one amendment (no firm-wide budget cap)
status: draft
---

## Overview

Stage 1 gives the spine a voice. Stage 0 (landed, deployed in shadow) already notices the gap —
a confirmed visit's time passed hours ago and nothing came back — and tells the **manager**.
Stage 1 inserts the ratified first rung *below* that: before the manager ever hears about it, a
model turn acting as a hard-capped **team-leader identity** composes ONE colleague-tone question
and delivers it through the technician's *own* agent (`openclaw agent … --deliver`, the verified
CLI gateway path). The reply flows back through the ordinary `record_field_note` capture path,
which is exactly what closes the gap. Budget, dedup, and the escalation ladder are server-side
mechanism, never prompt text. Direction doc:
`thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md`, constraints 1–5.

**What changed in the rebase (vs the pre-landing draft):** Stage 1 no longer builds its own
sweep. Feature A landed the detector framework (`src/jobs/watchers.ts`: tenant loop, naive-local
time math, two-homes activity check, fresh-gap pre-filter, cap, auto-resolve, one batched push)
— Stage 1 **plugs into it** as a routing layer plus one new lifecycle step for the model turn.
The draft's `src/teamLead/watcher.ts`, its private copy of
`listOverdueConfirmedAssignments`, its `unanswered_nudge` review kind, and its separate
escalation push are all deleted from the plan; the rebase checklist at the bottom of the old
draft is fully applied here.

## The ratified ladder, as mechanism

User decisions 2026-08-16 (recorded in Plan A + direction doc): max TWO touches per gap.

```
fresh gap (A's detector, unchanged)
   │
   ├─ technician nudgeable? (active + telegram + sandbox + host + budget + NUDGES_MODE=live)
   │        │yes                                │no (any reason)
   │   RUNG 1: nudge row → compose →       FALLBACK: A's manager review item,
   │   delivered via their own agent       exactly as deployed today
   │        │
   │        ├─ reply arrives → agent records it → capture lands → next tick
   │        │  auto-resolves the nudge (mechanism-verified fill, never model judgment)
   │        │
   │        └─ silence ≥ 48h → RUNG 2: A's manager review item (escalation copy:
   │           "…their assistant asked on <date>; no reply yet") — never a third touch
   │
   └─ budget exhausted → DEFER (retry next tick when the rolling window frees) —
      never dumped on the manager; a busy day must not convert into manager flood
```

Key consequences, stated so the review can veto them:
- **A nudged gap never also flags the manager** in the same breath — one surface per gap at a
  time. The manager item appears only as fallback or escalation.
- **"Nothing to report" counts as filled** (user-ratified 2026-08-16): if the
  technician replies "went fine, nothing notable", their agent records it via
  `record_field_note`, the capture lands, and the gap is mechanically filled — that IS the
  status update. Only *silence* escalates. No model ever judges whether an answer is good
  enough; the follow-up probing ("what did you replace?") lives in the receiving agent's
  conversation, steered by the delivered footer, not in more nudges.
- **Escalation reuses A's `overdue_visit_gap` kind and per-assignment once-ever dedup** — the
  manager's queue stays uniform, and one assignment can never produce both a fallback item and
  an escalation item. The escalation just carries different copy + `detail.escalatedFromNudge`.
- **Fresh** now means: not manager-flagged AND not nudged (a second batched pre-filter over the
  `nudges` table mirrors `listEverFlaggedSubjectRefs`). Without it, a nudged gap would look
  fresh forever and re-nudge every tick — the unique index is the backstop, the pre-filter is
  the mechanism.

## Decisions

Carried from the draft (reasoning unchanged, anchors re-verified against a0a9fd0):

- **Transport (D1) → the box PULLS a nudge queue**: `/control/nudges` GET + report POST under
  the existing `HOST_PULL_TOKEN` auth; a box-side runner executes the CLI locally. Rejected:
  Render→box ssh (no credential, inverts the posture); `/hooks/agent` (dead end on
  trades-box-1). Cost accepted: ≤5 min delivery latency.
- **Identity class (D2) → reserved-namespace ref + deny-by-default allowlist in `dispatch`.**
  `technicianRef = 'spine:team-lead'` — no roster row, no badge, no enum migration; `slugify`
  mints human refs over `[a-z0-9-]` so `:` can never collide. A roster-less identity today
  inherits the FULL technician surface (research constraint 3), so the gate denies the whole
  `spine:` namespace by default: only `TEAM_LEAD_TOOL_NAMES` (read-only v1) dispatch.
  Mechanism, not prompt.
- **Budget/dedup state (D3) → new `nudges` table**, tenant-scoped, whole lifecycle
  (pending → queued → asked → answered/escalated/cancelled/failed); plain unique index
  `(tenant_id, kind, subject_ref)` = ask once per subject, ever. `subject_ref` = assignment id,
  `kind` = `'overdue_visit_gap'` — deliberately the SAME key A's review items use, so the two
  dedup stores speak one vocabulary.
- **Capture policy (D4) → outreach NOT L1-captured** (user-ratified 2026-08-16). L1 is
  undeletable and the 2026-07-04 outbound exception does
  not extend by analogy; the `nudges` row (question, evidence, timestamps,
  `actor_ref='spine:team-lead'`) is the durable, prunable audit. The reply needs no new policy:
  person's agent → `record_field_note` → normal L1/L2, their ref.
- **Session (D6) → fresh session per nudge (`nudge-<id>`), self-contained copy** (eval-proven;
  id reuse resumes stale conversations). `OPEN — needs live evidence`: whether the human's
  Telegram reply lands in a session that still holds the question is unobserved. Phase 5
  resolves it; the copy names customer + date so the reply is recordable even context-less.
- **Budgets (user-ratified 2026-08-16):** 2 asks/person per rolling 24h; **NO firm-wide cap**
  (user amendment — volume should scale with the roster and the work; the watcher's per-tick
  cap of 5 fresh gaps per tenant stays as the surge brake, so a systemic glitch still can't
  blast a whole roster in one tick). Budget-exhausted DEFERS, never overflows to the manager.
  Escalate at 48h silence; compose/delivery attempts ≤3; serve cap 10. Env-overridable via
  `safeEnvInt`.
- **Fabrication guard (constraint 8):** code assembles the evidence block + standing footer; the
  model writes ONLY the question sentence (or declines). Dates printed by code from the row —
  bare date, no weekday, so the weekday guard has nothing to mismatch.
- **Copy doctrine (user-ratified at A's tone review, extends to technician-facing copy):** warm
  and professional, self-explaining, about the JOB never the person, and NO operator jargon —
  neither managers nor technicians have ever heard the word "spine".

New in the rebase:

- **Mode gating → new `NUDGES_MODE` env, independent of `WATCHERS_MODE`.** unset = rung 1 off
  (every fresh gap falls through to A's manager flag — today's deployed behavior, byte-for-byte);
  `shadow` = count would-be nudges in the summary (`nudgesWouldCreate`) while still flagging the
  manager (safe, observable); `live` = the ladder above. Watchers-live is a PREREQUISITE for
  nudges doing anything (shadow `continue`s before any write path). This lets Stage 1 land
  dark and flip on its own schedule, exactly like Stage 0 did.
- **Step numbering:** compose is lifecycle **step 9** (`teamLeadCompose`), key-gated like steps
  3/4, running EVERY tick (the 5-minute pulse is why delivery latency stays low; the model turn
  only fires when pending rows exist, so a quiet fleet costs nothing).

## Plain-language walkthrough

**Phase 1 — the notebook.** A new table, `nudges`, is the team leader's notebook: one row per
question it ever considers — who, about what, current state. A unique index makes "ask once,
not every 5 minutes" a database guarantee, not a promise.

**Phase 2 — the routing.** The deployed watcher already finds gaps every 5 minutes. This phase
teaches its live path one new move: when the technician is reachable and the budget allows,
write a `pending` nudge row *instead of* the manager item. It also closes nudge rows whose gap
got filled (same activity check that closes manager items) and escalates 48-hour silence into
the manager queue. Still zero model calls.

**Phase 3 — the brain.** A model turn reads each pending row's evidence and writes the question
("How did the Miller St visit (Aug 14) go?") — or declines. It acts under a new identity the
tool boundary caps to read-only tools by mechanism: even a buggy prompt cannot send email or
book a visit, because `dispatch` refuses those tool names outright.

**Phase 4 — the mouth.** The spine never reaches into the agent box; the box already phones
home every 5 minutes for badges. A sibling endpoint serves queued nudges the same way, and a
small box-side runner delivers each through the person's own agent and reports back. Lost ticks
self-heal: a nudge is served until acknowledged.

```
Render cron (*/5)                          trades-box-1 (5-min timer)
  step 8 watcher (landed) ─▶ fresh gap       GET /control/nudges ◀─ queued rows
    routing: nudgeable? ─▶ nudges: pending     nemoclaw <sandbox> agent --deliver
             fallback  ─▶ manager item         ──▶ person's Telegram, from THEIR agent
  step 9 compose (model) ─▶ queued           POST /control/nudges (ack) ─▶ asked
  next ticks: auto-resolve / escalate      human replies ─▶ agent ─▶ record_field_note
                                           ─▶ L1/L2 … next tick ─▶ answered
```

**Phase 5 — proof and disclosure.** One end-to-end run into a developer-owned chat (never a
real technician), plus the ratified worker disclosure in the firm-facing docs.

## Secrets & env preflight

- **Phases 1–2:** none new (local stack, `.env.test` — `already required`). New non-secret
  rollout env: `NUDGES_MODE` (unset in every environment until Phase 5).
- **Phase 3:** `MODEL_PROVIDER` + `INFERENCE_API_KEY` — `already required` (extractor). ⚠ Render
  currently holds the suspended Fireworks key (parked state 2026-08-15): compose reports
  per-row errors until rotated/billing-resumed; tests inject stubs. Optional:
  `TEAM_LEAD_BUDGET_PERSON_DAY`, `TEAM_LEAD_ESCALATE_HOURS`.
- **Phase 4:** `HOST_PULL_TOKEN` — `already required`; the runner reuses
  `/etc/doorman/badge-pull.env`. No new secret is minted anywhere in this plan.
- **Phase 5:** ssh to trades-box-1 + Render deploy + Supabase MCP (pilot) — operator-held
  already. **Prerequisite: `WATCHERS_MODE=live` on the pilot** (the pending shadow→live flip)
  — under shadow the watcher never reaches the routing layer, so no nudge can exist in prod.

## Phase 1: The `nudges` table + typed layer

### What this phase does
Creates the durable nudge state and its accessors; pays the cleanup-cascade debt immediately;
adds the review-items once-ever DB backstop Plan A's final review parked.

### Changes required

**`supabase/migrations/20260817090000_nudges.sql`** (new; grants + `updated_at` trigger
boilerplate mirrors `20260815160000_money_events.sql`)
- `nudges`: `id uuid pk`, `tenant_id uuid not null references tenants(id)`, `kind text not
  null`, `subject_ref text not null` (assignment id for this kind), `technician_id uuid
  references technicians(id)`, `status text not null default 'pending'` + CHECK in
  (`pending|queued|asked|answered|escalated|cancelled|failed`), `question text`,
  `context jsonb not null default '{}'`, `attempts int not null default 0`,
  `serve_count int not null default 0`, `actor_ref text not null default 'spine:team-lead'`,
  `resolution text`, `created_at/updated_at/queued_at/asked_at/resolved_at timestamptz`,
  `unique (tenant_id, kind, subject_ref)` (ask-once-ever — NOT partial).
- Same migration: partial unique index on `review_items (tenant_id, kind, subject_ref) where
  kind = 'overdue_visit_gap'` — the DB backstop for A's app-level once-ever guarantee, added
  now because this plan makes `flagOverdueVisitGap` two-caller (fallback + escalation).
  ⚠ Pre-flight on the pilot before Phase 5 applies it: confirm no duplicate rows exist
  (shadow mode wrote none, so this should be vacuously clean).

**`src/db/nudges.ts`** (new; tenant-scoped, `getClient()` only)
- `createPendingNudge(input)` — insert-catch-23505 → `null` (dedup IS the index);
- `listNudgesByStatus(tenantId, statuses)`;
- `listNudgedSubjectRefs(tenantId, kind, subjectRefs)` — batched any-status pre-filter,
  the exact `listEverFlaggedSubjectRefs` shape (chunked `.in()`, zero-input → `[]`);
- `markNudgeQueued(id, tenantId, question)` / `markNudgeOutcome(id, tenantId, status,
  resolution?)` — status-guarded conditional UPDATEs (the `resolveOpenReviewItemFor` shape);
- `countRecentAsks(tenantId, technicianId, sinceIso)` — per-person budget read over
  `created_at >= since`, statuses `pending|queued|asked|answered|escalated` (pending counts:
  a budgeted slot is claimed at creation, not at delivery).

**Registrations (eng-memory §1 rule — by name, this phase):** `scripts/spine-eval/world.mjs`
`RESET_TABLES` **and `PILOT_TENANT_SCOPED`** (adversarial-review finding: the second list is
DELETE-based and ordered — `nudges` must precede `technicians` or the roster delete 23503s and
rolls the pilot-world rebuild back); `scripts/seed.mjs` `truncateSpine` (existence-probed, the
tenant_profiles pattern — nudges genuinely escapes the cascade there because technicians are
preserved by default); `src/mcp/server.test.ts` full-spine truncate statement.
*Recorded deviation:* the draft said "add `nudges` wherever `review_items` is cleared" — NOT
done for the ~14 remaining test truncates, deliberately: every one of them truncates
`technicians … cascade`, which pulls `nudges` in through its FK, and none of those files write
nudges. Explicit registration is reserved for the sites cascade cannot reach.

**`src/db/index.ts`** — export the module. **`src/db/database.types.ts`** — regen from the
local stack after `npx supabase migration up` (pilot apply is Phase 5 rollout).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (full suite 1744 passed / 0 failed)
- [x] new `src/db/nudges.test.ts`: repeat insert → null; queued→asked legal, asked→queued
  refused; `countRecentAsks` window edges + pending-counts; `listNudgedSubjectRefs` batching +
  empty input; cross-tenant id resolves nothing (6/6)
- [x] review_items backstop: duplicate `overdue_visit_gap` insert for one subject now fails at
  the DB even bypassing the app guard (23505 asserted; other kinds keep open-only semantics)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [x] psql read-back: all columns/nullability, `uq_nudges_subject_ever` (non-partial),
  `uq_review_items_overdue_gap_ever`, both secondary indexes, `nudges_set_updated_at` trigger;
  `world.mjs` present-tables filter run non-destructively — 18 registered / 18 present /
  nudges included.

**Adversarial review (2026-08-16):** clean on schema/typed-layer/posture (reviewer re-ran the
gates and introspected the live DB independently); F1 = the `PILOT_TENANT_SCOPED` miss above,
fixed same day; F2 = the blanket-truncate instruction, resolved as the recorded deviation
above. Reviewer also confirmed `idx_nudges_budget` serves `countRecentAsks` and that the
backstop index's only residual race path fails loudly into the watcher's per-tenant catch and
self-heals next tick.

### Manual verification
- none
---
*No manual items — continue.*

## Phase 2: Routing, budget, auto-resolve, escalation (deterministic half)

### What this phase does
The deployed watcher learns the ladder — zero model calls. All changes live in
`src/jobs/watchers.ts` + its test; nothing new sweeps.

### Changes required

**`src/jobs/watchers.ts`**
- `WatchersSummary` gains `nudgeMode: 'off'|'shadow'|'live'`, `nudgesWouldCreate`,
  `nudgesCreated`, `nudgesResolved`, `nudgesEscalated`. `WatcherDeps` gains the nudge accessors
  (`createNudge`, `listNudged`, `listNudges`, `markOutcome`, `countAsks`) — same injectable-seam
  pattern as the existing 14.
- **Fresh pre-filter widens:** `fresh` = gaps in neither `listEverFlaggedSubjectRefs` NOR
  `listNudgedSubjectRefs` (two batched reads, both modes — `freshGaps` keeps meaning "what live
  would open", which now includes rung-1 asks).
- **Routing (live path, inside the existing capped `top` loop):** resolve the technician from
  the already-fetched `teamRows`; nudgeable = `NUDGES_MODE==='live'` AND state `active` AND
  `telegram_user_id` AND `sandbox_ref` AND `host_id` AND person-budget (no firm-wide budget —
  user amendment).
  Nudgeable → `createPendingNudge` with code-built `context` `{customerName, jobTitle,
  visitDay, visitEndLabel, technicianRef, assignmentId, jobId, startsAtLocal}` (reuses the
  `wallClockLabel` derivation); NOT nudgeable for any reason except budget → fallback =
  existing `flagOverdueVisitGap` call, untouched. Budget-exhausted → skip the row entirely
  this tick (defer; it stays fresh and retries). `NUDGES_MODE==='shadow'` → count
  `nudgesWouldCreate` for every would-be-nudgeable row, then fall through to the manager flag
  (deployed behavior preserved).
- **Auto-resolve extends to nudges:** open nudges (`pending|queued|asked`) join the existing
  batched activity read (their `context.jobId`/`startsAtLocal` feed the same `jobIds` set and
  floor computation); `hasActivitySince` → `markNudgeOutcome(…, 'answered', 'field report
  arrived')`; assignment left `confirmed` → `'cancelled', 'visit was <status>'`. Same
  fail-closed detail parsing as `openGaps`.
- **Escalation:** `asked` nudges with `asked_at` older than `TEAM_LEAD_ESCALATE_HOURS` (48) →
  `flagOverdueVisitGap` with escalation copy — same warm doctrine, e.g. *"⟨Tech⟩'s assistant
  asked about the '⟨title⟩' visit (⟨customer⟩) on ⟨bare date⟩ and hasn't heard back. Worth a
  direct word so the job's record gets closed out."* + `detail.escalatedFromNudge = nudge.id`
  → `markNudgeOutcome(…, 'escalated')`. The flag flows into the existing `opened` counter, so
  the SINGLE batched `notifyManagers` line per tenant per tick covers escalations too — the
  merged-push requirement from the STACK verdict, free by construction.
- `NUDGES_MODE` parsing mirrors `WATCHERS_MODE` in `src/jobs/lifecycle.ts`: unset → `'off'`
  silently (rung 1 is optional); any value other than `shadow|live` → step-level `stepError`
  (loud, the typo rule).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (full suite 1769 passed / 0
  failed on the worktree's dedicated stack)
- [x] watchers.test.ts additions: nudgeable → nudge row, NO manager item, NO push;
  unbound/inactive tech → manager item (deployed behavior); person budget 2 then defer;
  deferred row re-noticed next tick; nudged gap absent from
  `fresh` next tick; shadow mode → `nudgesWouldCreate` counted + manager item still opened;
  `NUDGES_MODE` typo → stepError; capture-after-start → nudge `answered`; visit cancelled →
  nudge `cancelled`; 49-hour `asked` → ONE manager item with escalation copy + `escalated`
  status + push fired once; escalated assignment never re-flags (once-ever holds)
- [x] lifecycle.test.ts: `NUDGES_MODE` joins the env-clear list; summary shape pinned

### Live verification (agent-executable)
- Prerequisites: local stack, `npm run seed:local`.
- [x] `node dist/jobs/lifecycle.js` with `WATCHERS_MODE=live NUDGES_MODE=live` on the local
  stack, four runs: nudge created for a staged overdue visit (`nudgesCreated:1`,
  `itemsOpened:0`); 49h-old `asked` → `nudgesEscalated:1` + ONE manager item with the warm
  escalation copy + `escalatedFromNudge` audit link; a visit row landing →
  `nudgesResolved:1` AND the escalated manager item auto-resolved on the same activity;
  `pushSkipped:true` honest without BOARD_BOT_TOKEN. All rows read back via pg.

**Adversarial review (2026-08-16, commit fe41dcf) + fixes:**
- **F1 (fixed):** the original code froze in-flight nudge sweeps when `NUDGES_MODE` ≠ live —
  combined with the both-stores fresh filter, a rollback would have orphaned asked-but-silent
  gaps on NEITHER surface forever. Now the sweep (auto-resolve + escalation) runs whenever
  the WATCHER is live; only rung-1 creation and compose are nudgeMode-gated. A rollback
  hands silent nudges to the manager — legal under the two-touch ceiling. Regression test
  added ("rollback rescue").
- **F2 (fixed):** the escalation's `escalated` mark is failure-isolated so a blip cannot
  abort the tenant loop after the manager item exists (the push still fires; the mark
  converges next tick on the once-ever dedup).
- **F3 (fixed):** corrected the escalation-loop comment (the guard, not the collection,
  drops malformed contexts). Known cosmetic gap: a malformed-context `asked` row re-collects
  every tick, never escalates, closes only via status change — invisible; consider a zombie
  counter when a second detector lands.
- **F4 (fixed):** added the incremental-budget test (second same-tech gap in one tick sees
  the first's pending row) + deferred-row-re-noticed test. Reviewer note stands:
  `nudgesWouldCreate` ignores budget (documented — it measures reachability).
- Reviewer independently verified: same-tick rung exclusivity, disjoint flag subject sets,
  single batched push, floor clamping vs malformed context, exact 2-cap and 48h boundaries,
  Stage-0 tests untouched, cadence gate untouched, tenant scoping on every new path.
- *Recorded deviation:* budget/escalation tuning are exported code constants
  (`NUDGE_BUDGET_PER_PERSON_DAY`, `NUDGE_ESCALATE_HOURS`), not env vars — the
  OVERDUE_HOURS pattern (one tuning surface); the plan's env-override idea dropped.

### Manual verification
- none
---
*No manual items — continue.*

## Phase 3: Team-lead identity ceiling + the compose turn

### What this phase does
The hard-capped identity class (mechanism, in `dispatch`) and the model turn that writes
questions.

### Changes required

**`src/mcp/server.ts`**
- `export const TEAM_LEAD_REF = 'spine:team-lead'`; `export const TEAM_LEAD_TOOL_NAMES = new
  Set(['query_spine', 'get_customer_context', 'resolve_date'])` (read-only v1; "stage" verbs
  are a future, separate decision).
- In `dispatch`, after the cost event (re-anchor the line — the file moved since the draft):
  `if (identity.technicianRef.startsWith('spine:') && !TEAM_LEAD_TOOL_NAMES.has(name)) throw
  new Error('the team-lead identity is capped to read/ask/stage — tool not allowed')`.
  Deny-by-default for the whole namespace: a forgotten entry fails closed (targetGuard
  doctrine). `tools/list` untouched — discovery is cosmetic, dispatch is the gate.

**`src/teamLead/compose.ts`** (new) — `composeNudge(nudge, deps)`:
- `runForcedTool` (`src/model/forcedTool.ts`) with forced schema
  `{ask: boolean, question: string, reason: string}` — structured output, no parsing.
- Prompt carries ONLY the code-built `context`; instruction: one colleague-tone question or
  decline — never invent facts, links, or dates. Copy doctrine applies (no jargon).
- Code assembles the delivered message: model question + code-printed evidence line
  ("re: ⟨customer⟩, ⟨jobTitle⟩, ⟨bare date⟩") + fixed footer directing the receiving agent:
  check your own conversation context first; if the technician answers, record via
  `record_field_note` (result-embedded directive — prompt rules are steering, not enforcement).
- `ask:false` → `markNudgeOutcome(…, 'cancelled', reason)`.

**`src/jobs/lifecycle.ts`** — step 9 `teamLeadCompose` (every tick, after step 8): `{skipped}`
when the inference key is unset (step-3/4 idiom); per-row try/catch, `attempts` ≥3 → `failed`;
success → `markNudgeQueued`. Summary `teamLeadCompose: {composed, cancelled, failed, rowErrors}
| {skipped} | {stepError}`.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (1769/0)
- [x] dispatch tests: with `spine:team-lead` identity, `resolve_date` dispatches;
  `record_field_note`, `send_email`, `book_visit`, `list_pending_reviews`,
  `add_team_member` all throw the cap error; an unknown `spine:*` ref gets the same
  ceiling (namespace-wide, fails closed); roster read tolerates the roster-less ref
- [x] compose (stubbed model): ask:true → queued with evidence line + footer; model sees
  ONLY the code-built context; ask:false → cancelled with reason; incomplete context →
  cancelled WITHOUT a model call; throw → rowError + attempts, cap → failed; unusable
  question (empty/oversize) → rowError; kind-scoped (8/8)
- [x] lifecycle step 9: NUDGES_MODE≠live → skipped; no key → skipped; passthrough; throw →
  stepError + red

### Live verification (agent-executable)
- Prerequisites: local stack + working inference key (key-gated, skip cleanly).
- [x] three real GLM composes (eval inference endpoint — the production wire dialect) on
  planted nudges: all queued, warm one-liners, zero invented facts, no dates in the model
  sentence, evidence line + footer intact. One run also exercised the attempt ladder live
  (attempt 1 failed on a missing key, attempt 2 composed and queued).

**Implementation notes:** identity constants live in `src/teamLead/identity.ts` (not
server.ts — compose must not import the whole MCP server for a constant; the gate in
`dispatch` imports from there). `setNudgeAttempts` added to `src/db/nudges.ts`
(pending/queued-guarded literal write — single-writer cron). Step 9 is additionally gated
on `NUDGES_MODE='live'`: a rolled-back ladder must not keep composing leftovers (creation
and compose are what a rollback turns off; the in-flight sweep keeps running in step 8).

**Adversarial review (2026-08-16, commit 8b8f452) + fixes (all landed same day):**
- **F1 (HIGH, fixed):** a nudge dying terminal WITHOUT the ask ever landing (model declined /
  context incomplete / compose failed 3x) orphaned its gap from every surface — the ever-
  nudged pre-filter + once-ever index left no path back. Fix: `handToManager` — decline,
  thin-context, and attempt-cap paths now flag the manager (Stage-0 copy +
  `detail.escalatedFromNudge`) BEFORE closing the nudge; summary gains `handoffs`. The
  reviewer's live scenario (Render's suspended Fireworks key failing every compose within 3
  ticks of a live flip) now lands every gap in the manager queue instead of a void.
- **F2 (fixed):** trust-boundary flattening — context strings (customer/title/name) and the
  model's question are control-char-stripped, newline-collapsed, and length-capped before
  entering the prompt or the deliverable, so nothing can forge the footer's
  "Note for the assistant" register (which rides on newlines); a model question IN that
  register is refused outright. Residual blast radius (reviewer-verified): the receiving
  agent's irreversible verbs are human-confirmation-gated, so worst case is misdirection,
  not action.
- **F3 (fixed):** `setNudgeAttempts` is pending-only and the terminal path is gated on the
  bump landing — a lost `markQueued` response can no longer destroy a successfully queued
  deliverable.
- **F4 (fixed):** the worktree scratch-stack `supabase/config.toml` leak reverted from the
  branch (CLAUDE.md: leave uncommitted; second occurrence of this exact leak — watch it in
  every worktree commit).
- **F5 (fixed):** migration `20260817100000_reserve_spine_namespace.sql` — CHECK
  (`ref not like 'spine:%'`) on technicians makes the namespace reservation structural: no
  operator script can ever mint a `spine:*` roster row, which would have hollowed the
  ceiling via the Composio relay (the one tool path that routes around dispatch and keys on
  row existence). Wording note: the gate's error says "read/ask" (accurate for v1) where
  the plan wrote "read/ask/stage" — code wins.
- Reviewer attacked and found clean: dispatch order + all bypass routes (relay covered by
  F5), allowlist read-only-ness (query_audit = by-design logging; dropSensitive applies to
  the roster-less ref), attempts arithmetic, step-9 cost bounding and loud-typo behavior.
  Full suite after fixes: 1772 passed / 0 failed.

### Manual verification
- [ ] Read 2–3 composed questions: colleague tone, not audit tone (direction constraint 5 +
  copy doctrine)?
---
*Pause after this phase — the manual tone check is non-empty.*

## Phase 4: Transport — pull queue + box runner

### What this phase does
Queued nudges reach the box the way retirements do: served on a host-token pull until
acknowledged.

### Changes required

**`src/control/nudgeQueue.ts`** (new; `badgeFile.ts` dep-injection pattern)
- `buildNudgeDelivery(hostId, deps)`: `queued` nudges whose technician's `host_id` = hostId
  AND state active AND `sandbox_ref`/`telegram_user_id` present (liveness re-filtered at serve
  time) → `[{id, sandboxRef, replyTo, sessionId: 'nudge-'+id, messageB64}]`; increments
  `serve_count`; `serve_count > 10` → `failed` ('undeliverable') instead of serving — a poison
  item must not re-alarm forever.
- `completeNudgeDelivery(id, outcome, detail)`: `delivered` → `asked` (+`asked_at`);
  `failed` → attempts++, ≥3 → `failed`.

**`src/mcp/httpServer.ts`** — two routes beside `/control/badges`, same host-token gate and
pre-allowlist placement: `GET /control/nudges`; `POST /control/nudges` (body capped, the
board's idiom).

**`Box_Setup_Stuff/nudge-runner.sh` + `.service` + `.timer`** (new; 5-min timer; ops-report.sh
discipline: separate unit, ALWAYS exits 0, hard `--max-time`/`timeout`): curl GET with
`HOST_PULL_TOKEN` from `/etc/doorman/badge-pull.env`; per item: validate `sandboxRef` against
`^[A-Za-z0-9_]+$`, `MSG=$(base64 -d)`, `timeout 180 nemoclaw $sref agent --agent main
--session-id $sid -m "$MSG" --deliver --reply-channel telegram --reply-to $replyTo
</dev/null`. Success judged by assistant text in the session TRAJECTORY
(`nemoclaw $sref exec --no-tty -- cat /sandbox/.openclaw/agents/main/sessions/$sid.jsonl`) —
never stdout, never `docker exec` (nested netns). One item's failure never aborts the loop;
then POST the outcome.

**Docs sync (standing rule):** `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` install
section + `docs/nemoclaw-tech-agent.md` (the agent stack gained a component).

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] `src/control/nudgeQueue.test.ts`: host isolation; inactive recipient filtered at serve
  time; serve cap → failed; ack → asked; failure ×3 → failed
- [ ] `src/mcp/httpServer.test.ts`: bad/missing host token → 401 both routes; GET shape; POST
  ack
- [ ] `bash -n Box_Setup_Stuff/nudge-runner.sh`

### Live verification (agent-executable)
- Prerequisites: local stack; curl.
- [ ] run the HTTP server locally, GET/POST with the test host token — shapes + row
  transitions read back via psql.

### Manual verification
- none
---
*No manual items — continue.*

## Phase 5: Rollout, live E2E, disclosure docs

### What this phase does
Migrate-then-deploy, install the runner, prove one full loop into a developer-owned chat,
resolve the D6 open question, ship the ratified disclosure.

### Changes required
- **Prerequisite check (blocking):** `WATCHERS_MODE=live` on the pilot cron — the joint
  shadow→live flip decision. If still shadow when implementation reaches here, STOP and settle
  the flip (incl. the demo-tenant question) with the user first.
- **Rollout order (design artifact):** (1) pilot migration via Supabase MCP + `NOTIFY pgrst,
  'reload schema'` (backstop-index preflight first); (2) Render Manual-Deploy the LATEST
  commit, verify the live hash; (3) install runner + units on trades-box-1, `daemon-reload`,
  enable timer, verify a no-op pull; (4) set `NUDGES_MODE=shadow` on the cron service, read
  `nudgesWouldCreate` for a day; (5) flip `NUDGES_MODE=live` with the user. Escape hatch:
  `systemctl disable --now nudge-runner.timer` stops all delivery instantly; unsetting
  `NUDGES_MODE` restores Stage-0 behavior exactly; the lifecycle steps alone only write DB
  rows.
- **Docs:** `docs/customer-onboarding-runbook.md` + `docs/getting-started-for-firms.md` —
  extend the recorded disclosures with the ratified 2026-08-15 one: the firm's assistant may
  proactively ask about work, and what you tell it can be recorded to the firm's record.
  `docs/engineering-memory.md` — live-state entry (new table, identity namespace, box
  component, NUDGES_MODE, D4/D5 decisions).

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` / `npm run build` pass (pre-PR gate)

### Live verification (agent-executable)
- Prerequisites: ssh trades-box-1; Supabase MCP (pilot); a synthetic overdue visit under the
  demo tenant with a DEV seat as technician — target an operator-owned chat (e.g.
  s2/manager-sam), NEVER a real technician's.
- [ ] full loop: nudge row pending→queued→asked; gateway log shows `[ws] ⇄ res ✓ agent`
  (gateway, not embedded); message in the operator's Telegram; weekday-guard log checked
- [ ] operator replies ("went fine, replaced the capacitor") → agent records via
  `record_field_note` → capture read back; next tick marks the nudge `answered`
- [ ] **resolve D6:** which session the reply landed in, was the question in context — record
  in engineering-memory; if context was absent and the flow failed, revisit session targeting
  before enabling any real recipient
- [ ] budget regression: second same-person overdue visit → row only if under budget; third →
  deferred
- [ ] escalation regression: force an `asked_at` 49h back on the synthetic nudge → manager
  item with escalation copy appears; assignment never double-flags

### Manual verification
- [ ] The delivered message reads as a colleague's question on a real phone (constraint 5 tone)
- [ ] Disclosure wording honest and plain (user review)
---
*Pause: manual items + the D6 resolution are user-facing.*

## File footprint

Create: `supabase/migrations/20260817090000_nudges.sql`, `src/db/nudges.ts`,
`src/db/nudges.test.ts`, `src/teamLead/compose.ts`, `src/teamLead/compose.test.ts`,
`src/control/nudgeQueue.ts`, `src/control/nudgeQueue.test.ts`,
`Box_Setup_Stuff/nudge-runner.sh`, `Box_Setup_Stuff/nudge-runner.service`,
`Box_Setup_Stuff/nudge-runner.timer`.

Modify: `src/db/index.ts`, `src/db/database.types.ts` (regen), `src/jobs/watchers.ts`,
`src/jobs/watchers.test.ts`, `src/jobs/lifecycle.ts`, `src/jobs/lifecycle.test.ts`,
`src/mcp/server.ts`, `src/mcp/server.test.ts`, `src/mcp/httpServer.ts`,
`src/mcp/httpServer.test.ts`, `scripts/spine-eval/world.mjs`, `scripts/seed.mjs`,
`docs/engineering-memory.md`, `docs/control-plane.md` (NUDGES_MODE env),
`docs/customer-onboarding-runbook.md`, `docs/getting-started-for-firms.md`,
`docs/nemoclaw-tech-agent.md`, `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`.

Deleted from the draft footprint (rebase): `src/teamLead/watcher.ts(+test)` (folded into
watchers.ts), `src/db/assignments.ts` (A's lister reused as-is), `src/db/reviewItems.ts`
(`unanswered_nudge` kind dropped — `overdue_visit_gap` covers both rungs).

**Cross-feature overlap:** `src/jobs/lifecycle.ts(+test)` and both firm-facing docs are ALSO
in `2026-08-15-money-inference-v1.md` Phase 3 (its `job_done_check` would become detector #2
in the watcher framework). Stack, don't parallelize: whichever lands second rebases.

## Assumptions

- Product-facing choices **user-ratified 2026-08-16**: D4 (outreach not L1-captured);
  "nothing to report" = filled / silence-only escalates; 2 asks/person per rolling 24h with NO
  firm-wide cap (user amendment); budget-exhausted defers rather than falling back to the
  manager; read-only v1 tool allowlist for the team-lead identity.
- `runForcedTool` is assumed usable by a second consumer (it is the extractor's seam); if it
  proves extract-specific, compose adds a sibling helper in `src/model/` instead of widening
  it.
- Migration timestamp `20260817090000` assumes no earlier-numbered migration lands first;
  renumber on rebase.
- The `dispatch` gate line anchor must be re-found at implement time (server.ts moved since
  the pre-landing draft).
