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
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test` pass
- [ ] new test: `spine_read` dispatches for `spine:team-lead` and returns rows
- [ ] new test: `spine_read` is NOT in `ADMIN_TOOL_NAMES` (guards the whole design)
- [ ] new test: a write tool still hits the cap error for `spine:team-lead`
- [ ] new test: `runToolLoop` stops at `MAX_TURNS` and records usage per turn
- [ ] mutation check: removing the `spine_read` case makes its test fail

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; a provider key in `.env` for a real loop call
- [ ] run a loop asking a question that needs a lookup ("how many jobs completed this week")
      and confirm it made ≥1 tool call and returned a number matching a direct SQL read

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

**`supabase/migrations/20260820120001_review_items_ever_index.sql`** (new)
- The any-status backstop index is partial — `where kind = 'overdue_visit_gap'`
  (`nudges.sql:76-78`). Add the equivalent for `job_cost_gap`, or replace both with a
  kind-generic one. **Check for existing duplicate rows before adding a unique index.**

**`src/teamLead/compose.ts`**
- The pending filter (`:177`) additionally skips rows whose `not_before` is in the future.

### Automated verification
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test` pass
- [ ] new test: a row with `escalate_after` in the past escalates; null falls back to 48h
- [ ] new test: a row with `not_before` in the future is not composed, and IS composed after
- [ ] new test: an open `job_cost_gap` review item auto-resolves when its job gains a cost
- [ ] existing watcher/compose suites pass unchanged (this phase must be behaviour-identical)

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (pilot is READ-ONLY here — read-backs only)
- [ ] apply both migrations to the local stack; confirm the columns exist and are nullable, and
      that the new index creation did not fail on existing rows

### Manual verification
- [ ] none

---

## Phase 3: The planner, in shadow

### What this phase does
Runs the planner every 30 minutes, produces a plan, writes nothing. Measures cost and judgment.

### Changes required

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
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm test` pass
- [ ] new test: shadow mode writes NOTHING — assert with a stub that no write dep is called
- [ ] new test: the evidence projection excludes anything at or before `asked_at`
- [ ] new test: a decision without a citation cannot produce `close` (code-side guard, not prompt)
- [ ] new test: outside the ask window the model dep is never invoked
- [ ] new test: the 30-minute gate — `:00`/`:30` run, `:10`/`:40` skip

### Live verification (agent-executable)
- Prerequisites: `render` MCP (workspace `tea-d69903h5pdvs738dm81g`); `supabase-test` MCP for
  read-backs; `PLANNER_MODE=shadow` set on the cron
- [ ] after deploy, read cron logs for ≥3 planner ticks; capture per-call token counts and
      latency, and confirm `nudges` rows are byte-identical before and after (shadow proves itself
      by changing nothing)
- [ ] record the measured cost per call — this is the number the cost question has been waiting on

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
