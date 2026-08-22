---
date: 2026-08-22
task: Closing a gap becomes the planner's judgment; the sweep keeps the facts and a fail-safe
research: thoughts/shared/research/2026-08-22-brain-memory-foundations.md
status: draft
---

## Overview

Today the sweep decides everything mechanically every 5 minutes and the planner advises every 30,
so the fast dumb thing always wins the race. That is backwards from the AI-manager premise. This
plan moves the one verb that needs a mind — **closing a gap** — to the planner, leaves every
factual close with the sweep, and keeps a fail-safe so a dead planner cannot wedge the queue.
It also gives an answer a durable link to the question it answered.

The ref code is **gone** (see Decisions). Delivery cost is **out of scope** — a separate plan.

## Decisions

- **Closing moves to the planner — USER, 2026-08-22.** `spec.filled` ("did this answer the
  question?") is the only sweep close that is a judgment; `moot`, escalate, expire and the
  delivery caps are all facts read off a column. The planner already owns the one timeline that
  mattered (`escalate_after`). Consequence, and the reason this is worth doing: the gap stays open
  until the planner acts, so the planner **sees the answer** — which fixes the two-gaps-one-job
  case, gives the planner a feedback loop it has never had, and makes every close a recorded
  decision with a reason and a citation.
- **`basis` already IS the answered/filled distinction — decided here.** `basis:'record'` means
  the record says the hole is shut; `basis:'evidence'` means a person said so. The `record_filled`
  column the earlier draft added is redundant once the planner closes, so it is dropped.
- **Fail-safe = one working day, anchored to the escalation deadline — USER set the duration,
  2026-08-22.** Not a new constant: the deadline is already 24h by default, planner-adjustable,
  48h hard ceiling. It is also exactly where the damage lands — the moment the sweep would hand a
  manager a gap claiming nobody answered. At that instant: answered but no planner decision →
  close automatically and say so; otherwise escalate as today. `extend` moves the fail-safe with
  it, which is correct — the planner asking for more time means more time for both.
- **The fail-safe must not override a live planner — decided here.** It fires only when the gap
  has **no applied planner decision in the last 24h**. If the planner has been deciding about this
  gap and chose not to close it, that is a judgment, not an outage, and it escalates as today.
- **No ref code — USER, 2026-08-22.** Rejected after building the case for it. Three reasons, in
  order of weight: (a) under the current `--deliver` path the ref must survive a rewrite by an
  agent whose own footer tells it to strip "any internal detail", and a stripped ref is silent;
  (b) under direct send the technician would read `(ref K7M2QX4P)` in their chat — the same
  machine-artifact-in-a-human's-face mistake as showing a manager the planner's reasoning;
  (c) the spine can attribute without it in every case except two-open-gaps-on-one-job, and that
  case is now the planner's to judge, which is what this plan is about.
- **Attribution is spine-side and code-only — decided here.** At `record_field_note` time the
  spine knows the technician, resolves the job, and can read its own open gaps. Exactly one open
  gap on that job → stamp it. More than one → stamp nothing and let the planner read the words.
- **Delivery cost is a separate plan — decided here.** Measured: one nudge costs 6 turns /
  84,251 uncached input, and `openclaw message send` (no inference) plus the channel-history
  injection would make it ~0. That work is box-side and needs a fleet re-wire; this plan is
  spine-only and needs none. See the BLOCKER section of the previous revision, retained in git.

## Plain-language walkthrough

**Phase 1 — an answer remembers which question it answered.** When a technician replies, the note
lands as a permanent record but nothing says what it was about. This phase has the spine check its
own open questions at the moment the note is recorded: if there is exactly one open question for
that person on that job, the note is linked to it. If there are two, it links nothing rather than
guessing — the planner sorts those out in Phase 2.

**Phase 2 — closing becomes a decision instead of a reflex.** Today any activity on a job closes
the question, whether or not it answered anything. After this phase the question stays open until
the planner reads the reply and decides, and its reason is recorded. The sweep still closes
everything factual — cancelled visits, expired asks, undeliverable messages — and still closes
automatically if a full working day passes with the planner silent, saying plainly that is what
happened.

```
   BEFORE                                  AFTER
   ──────                                  ─────
   sweep  (5 min)   closes everything      sweep    detects, routes, escalates,
   planner(30 min)  advises                         closes on FACTS,
                                                    fail-safe closes after 1 working day
                                           planner  closes on JUDGMENT, with a citation
```

**Phase 3 — the quiet ticks leave a trace.** Unchanged from the previous revision: the planner
writes a row for every gap it considered, including the ones it left alone, and reads back one
line carrying elapsed time and a consideration count.

## Secrets & env preflight

- **Phases 1–3:** none.

Every phase needs the local Supabase stack (`npx supabase start`, `.env.test`) and ends with
**`npm run gen:types:local`** — never `npm run gen:types`, which is `--linked` to the pilot.
**Grep `project_id` in `supabase/config.toml` before any local supabase command.**

---

## Phase 1: An answer remembers its question

### What this phase does
At `record_field_note` time the spine looks up its own open gaps for that technician on that job
and, when exactly one is open, stamps the answering capture onto it. No ref, no message change, no
box change. `buildGapView` then marks attributed evidence so the planner can see it in Phase 2.

### Changes required

**`supabase/migrations/20260822120000_nudge_answered_by.sql`** (new)
- `alter table nudges add column answered_by_capture_id uuid;` — no FK: L1 is append-only and must
  not be constrained by the ladder (`nudge_decisions.job_id` precedent).

**`src/db/nudges.ts`**
- `listOpenNudgesForTechnicianJob(tenantId, technicianId, jobId): Promise<Nudge[]>` — filters
  `tenant_id`, `technician_id`, `status in OPEN_NUDGE_STATUSES`, and `context->>'jobId' = jobId`.
- `setNudgeAnsweredBy(id, tenantId, captureId): Promise<Nudge | null>` — guarded with
  **`.is('answered_by_capture_id', null)`** so the first answer wins. `.eq(col, null)` renders as
  `col=eq.null` and matches ZERO rows; there is no `.eq(x, null)` anywhere in `src/db/`.

**`src/mcp/server.ts`** — in the `record_field_note` dispatch ([:2239](src/mcp/server.ts#L2239))
- **After** a `recorded` result, never before: `recordFieldNote` resolves the job *after* the L1
  append ([recordFieldNote.ts:251](src/writePath/recordFieldNote.ts#L251)), so use the `captureId`
  and `jobId` the commit returns.
- `caller` is null for a **roster-less badge** ([:2256](src/mcp/server.ts#L2256)) — no
  `technicians.id` to scope by, so attribute nothing. Fail-closed.
- Exactly one open gap → `setNudgeAnsweredBy`. Two or more → nothing.
- Attribution must never fail the call: wrap in try/catch and log. A lost link is a lost link; a
  lost note is a lost note.
- Applies to **all three** `commitNote` sites ([:2316](src/mcp/server.ts#L2316),
  [:2464](src/mcp/server.ts#L2464), [:2516](src/mcp/server.ts#L2516)) — the two resume paths are
  where a nudge answer most often lands.

**`src/teamLead/planner.ts`**
- `buildGapView` marks evidence the technician submitted as this gap's answer as
  `ANSWERS THIS GAP: "…"`. No new parameter and no new read — `answered_by_capture_id` is a column
  on the `Nudge` the function already receives; compare against `e.capture.id`.
- Suppress the `sharesJob` SHARED warning **for an attributed capture only**; it stays for the rest.
- Three callers move: [planner.ts:1141](src/teamLead/planner.ts#L1141),
  [planner-eval/run.mjs:81](scripts/planner-eval/run.mjs#L81),
  [planner.test.ts:1656](src/teamLead/planner.test.ts#L1656).

### Automated verification
- [ ] the CLAUDE.md gates (typecheck / lint / test) + `npm run gen:types:local`
- [ ] one open gap on the job → stamped; two open gaps → nothing stamped
- [ ] another technician's open gap on the same job is NOT stamped
- [ ] a roster-less badge attributes nothing and still records the note
- [ ] `setNudgeAnsweredBy` stamps once and is a no-op on a second call **with a different capture
      id** — proves the `.is()` guard rather than the happy path
- [ ] attribution throwing does not fail `record_field_note`
- [ ] **the stamp survives a `needs_identity` round-trip** — stage, resume with `confirmId` +
      `confirmed`, assert the nudge is stamped (the resume paths are the common case)
- [ ] two gaps on one job, one capture attributed: the attributed gap's view says
      `ANSWERS THIS GAP` and drops the SHARED warning; the other gap's view keeps both

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test`.
- [ ] After deploy, a pilot nudge answered through a seat carries `answered_by_capture_id` naming
      the capture whose text is the answer. Evidence: both rows.

### Manual verification
- None.

---

## Phase 2: Closing becomes the planner's judgment

### What this phase does
Removes `spec.filled` from the sweep's close path, leaving the planner's `close` as the normal way
a gap ends. The sweep keeps every factual close and gains one fail-safe at the escalation
deadline, which fires only when the planner has been silent for a working day.

### Changes required

**`src/jobs/watchers.ts`** — the nudge sweep loop ([:565](src/jobs/watchers.ts#L565))
- **Delete the `filled` close.** The `filled` branch no longer calls `resolveNudge`. `moot` is
  untouched — a cancelled visit or job is a fact.
- **Fail-safe at the deadline.** In the `status === 'asked' && dueAt <= nowMs` branch, before
  pushing to `escalations`:
  ```
  const answered = spec.filled(x.n, facts);
  const JUDGMENTS = new Set(['send','hold','close','escalate','extend','leave']);
  const plannerAlive = (decisions.get(x.n.id) ?? []).some(d =>
        d.outcome === 'applied' && JUDGMENTS.has(d.action) &&
        Date.parse(d.decided_at) > nowMs - 24*3_600_000);
  if (answered && !plannerAlive) → resolveNudge(id, tenant, 'answered',
        `closed automatically — the answer landed but the planner did not act: ${answered}`)
  else → escalations.push(x)   // unchanged
  ```
- **The decisions read must move.** It is currently fetched *after* this loop, only for
  `escalations` ([:680](src/jobs/watchers.ts#L680)). It now gates the loop, so hoist the batched
  `listDecisions` call above it, keyed on every open `asked` nudge, and keep its try/catch. On a
  read failure treat `plannerAlive` as **true** — fail toward escalation, never toward an
  automatic close on missing evidence.
- **CROSS-PHASE HAZARD — `plannerAlive` must exclude `'unmentioned'`.** Phase 3 writes an
  `unmentioned` row with `outcome: 'applied'` for every gap the planner merely looked at. A naive
  `outcome === 'applied'` test would therefore be true for every open gap on every tick once
  Phase 3 lands, and **the fail-safe would silently never fire again**. `unmentioned` means "saw
  it, said nothing"; only a real verb is a judgment. The `JUDGMENTS` set above is what keeps the
  two phases from cancelling each other, and a test must pin it (below).
- `itemResolved` (manager review items) is unchanged — a manager's item still auto-resolves.

**`src/jobs/nudgeKinds.ts`**
- `filled`'s doc comment changes meaning: it now answers *"is this gap answerable?"* and is
  consumed by the fail-safe and by the gap view — **not** by a close. Say so, loudly, because a
  future reader will otherwise re-wire it to close.
- **No `holeClosed`, no `record_filled`** — dropped; `basis` carries that distinction now.

**`src/teamLead/plannerPrompt.ts`**
- The prompt already describes `close` with `basis` and `citation`. Add one line: closing is now
  the ONLY way an answered gap ends before its deadline, and leaving an answered gap open until
  the deadline means it closes itself and says the planner did not act.

### Automated verification
- [ ] the CLAUDE.md gates (typecheck / lint / test)
- [ ] activity on a job **no longer closes** its gap on the sweep — the gap stays `asked`
- [ ] `moot` still closes immediately (cancelled visit, cancelled job)
- [ ] at the deadline with activity and **no** applied planner decision in 24h → auto-closed, and
      the resolution text names the fail-safe
- [ ] at the deadline with activity and an applied planner decision in 24h → **escalates**, does
      not auto-close (the planner's judgment stands)
- [ ] **at the deadline with activity and only `unmentioned` rows → AUTO-CLOSES.** This is the
      cross-phase regression test: `unmentioned` must not read as a live judgment, or Phase 3
      silently disables Phase 2's fail-safe
- [ ] at the deadline with no activity → escalates, exactly as today
- [ ] a `listDecisions` failure at the deadline → escalates (fails toward the manager)
- [ ] the planner's own `close` still works and still requires `basis` + `citation`
- [ ] expire / serve-cap / delivery-cap paths are untouched

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test`.
- [ ] After deploy, watch one pilot gap through a full cycle: answered → stays open across at
      least one sweep tick → closed by a planner decision. Evidence: the nudge row's
      `resolution`, and the matching `nudge_decisions` row with its reason and citation.

### Manual verification
- [ ] The auto-close resolution text reads sensibly to a manager who encounters it.

---

## Phase 3: The quiet ticks leave a trace

### What this phase does
Writes one `nudge_decisions` row per open gap per planner tick — including gaps the model did not
mention, and including a tick that failed outright — and replaces the pushed history line with one
carrying elapsed time and a consideration count.

### Changes required

**`supabase/migrations/20260822140000_nudge_decisions_leave.sql`** (new)
- Drop and re-add `nudge_decisions_action_check` with `'leave'` and `'unmentioned'` added to the
  existing five. Follow [20260821180000_nudge_decisions_extend.sql](supabase/migrations/20260821180000_nudge_decisions_extend.sql)
  exactly, including its `drop constraint if exists` and its verify-the-name-against-the-pilot note.

**`src/teamLead/planner.ts`**
- `PLANNER_ACTIONS` gains `'leave'`. `'unmentioned'` is **code-only**, never in that array — it
  must be unwritable by the model, and `validateDecisions` must refuse it.
- **Do not widen `JUDGMENTS` in `watchers.ts` to include `'unmentioned'`** — see the cross-phase
  hazard in Phase 2. Adding a new *real* action later means adding it there too.
- `SUBMIT_PLAN_TOOL`'s action enum gains `'leave'`; `PLANNER_SYSTEM` gains one line: it means "I
  looked and I am waiting", takes a reason, changes nothing.
- `applyDecision` gains `case 'leave': return { outcome: 'applied' };` — the switch is exhaustive
  over `PlannerDecision['action']` with no `default` ([:986](src/teamLead/planner.ts#L986)), so
  this is required for the build.
- After the `decisions` and `dropped` loops ([:1227](src/teamLead/planner.ts#L1227)), append a
  third source: every `nudgeId` in `views` in neither, as
  `{ action: 'unmentioned', confidence: 'low', reason: '', outcome: live ? 'applied' : 'shadow' }`.
- **The failure path too:** the per-tenant `catch` ([:1330](src/teamLead/planner.ts#L1330)) sits
  after `runLoop`, so a `ToolLoopLimitError` or provider error currently writes nothing. Append one
  `unmentioned` row per view there with `outcome: 'refused'`, `outcomeDetail: 'tick failed: <msg>'`.
  Without this the phase's own goal fails in exactly the case worth knowing about.
- `historyLine(history, nowMs, tz)` ([:331](src/teamLead/planner.ts#L331)) — **`tz` is a new
  parameter**, threaded from the call at [:457](src/teamLead/planner.ts#L457) — becomes:
  `watched since <first decided_at via clockLabel> — considered N×, last: <action><marker> Xh ago.`
  - `last` = the newest row whose `action !== 'unmentioned'`. Rendering `history[length-1]` would
    say `unmentioned` on nearly every gap, since filler is appended every tick. When there is no
    real decision yet, omit the `last:` clause rather than inventing one.
  - `N` = `history.length`. Rows predating this phase under-count, so say "considered" (what a row
    now means), never a tick count the data cannot back.
  - Still returns `null` on empty history.
- Three tests pin the current bytes and must move with it:
  [planner.test.ts:1009](src/teamLead/planner.test.ts#L1009), [:1019](src/teamLead/planner.test.ts#L1019),
  [:1025](src/teamLead/planner.test.ts#L1025).

**`src/db/nudgeDecisions.ts`**
- `listDecisionsForNudge` / `listDecisionsForJob` (the `recall_decisions` lookups) filter out
  `action = 'unmentioned'`. `listDecisionsForNudges` (the per-tick read feeding `historyLine`)
  keeps them — the count is the point.
- **Add `.order('id')` after `.order('decided_at')`** in all three: `decided_at` defaults to
  `now()`, so every row from one insert shares a timestamp and "newest" is otherwise undefined.
- Growth note: rows accrue per open gap per in-window tick (~24/day), bounded by gap lifetime (18h
  delivery deadline + 48h absolute ceiling) — **except** under `NUDGES_MODE` off/shadow with
  `PLANNER_MODE` live, where nothing closes gaps. Add a per-gap cap: stop appending `unmentioned`
  once a gap's history exceeds 200 rows, logging once when it first bites.

### Automated verification
- [ ] the CLAUDE.md gates (typecheck / lint / test) + `npm run gen:types:local`
- [ ] 3 open gaps, model names 1 → **3** rows (1 decision, 2 `unmentioned`)
- [ ] an EMPTY plan over 3 open gaps writes 3 rows (today: zero)
- [ ] a tick whose `runLoop` throws writes 3 `unmentioned` rows with `outcome='refused'`
- [ ] `leave` records the model's reason; `unmentioned` records none — distinguishable
- [ ] `'unmentioned'` submitted by the model is REFUSED by `validateDecisions`
- [ ] shadow mode writes `outcome='shadow'` and touches no nudge
- [ ] `recall_decisions` omits `unmentioned`; the per-tick read includes them
- [ ] **`historyLine` reports the last REAL action** with 20 `unmentioned` rows appended after it —
      the test that would have caught the filler bug
- [ ] `historyLine` omits `last:` when every row is `unmentioned`; returns null on empty history
- [ ] the 200-row cap stops appending and logs once

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test`.
- [ ] After deploy, one in-window tick adds a row per open pilot gap rather than zero. Evidence:
      `select action, count(*) … group by action` before and after, with timestamps.

### Manual verification
- None.
