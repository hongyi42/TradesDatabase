---
date: 2026-07-23
task: 4a.5 — board quick-edit: tap-assign picker, detach/park verb, tray booking sheet, editable visit sheet, compressed customer notes, time_only promise level
research: thoughts/shared/research/2026-07-23-plan-4a5-board-quick-edit-verbs.md
status: draft
---

## Overview

Make the Mini App board the manager's hands (principle evolution, 2026-07-23): assign/reassign
via a tap picker, pull a person off a visit without cancelling (new detach capability, threaded
through every layer), book unscheduled jobs from the tray, edit every visit-level row on the
detail sheet, and show a compressed customer-notes section. Every gesture calls the same shared
verbs the chat agent drives — one write path, one promise-ladder gate.

## Decisions

All user decisions 2026-07-23 unless marked (impl):
- **No lane changes; assignment = tap picker** (research D1/D2 option C). Existing drag stays
  exactly as-is; drag-to-empty-technician stays impossible and that is accepted.
- **Roster for the picker** (impl): new manager-only `GET /board/api/roster`, fetched on picker
  open (bucket-pill pattern — never on the load path). Filter mirrors `resolveTechnician`:
  everything non-inactive (`!isInactiveState`), so seat-exempt and invited rows appear exactly
  when chat booking would accept them; offboarded never.
- **Parked visits assign via the same picker** (tray row → picker; detail sheet → picker).
- **Tray booking sheet for unscheduled jobs** (research D4 option A) **+ a promise-level
  selector** — labels `none / day / day+time` mapping to the stored `none/day/time`.
  Board books **existing jobs only** (jobId path; the customerId mint-a-job path stays chat-only).
- **Detach/park: build the verb; expose BOTH gestures** — drag onto the Unassigned lane, and
  "None" as a picker option when editing an existing visit.
- **Writes stay manager-only** (all new endpoints 403 non-managers, like move/cancel).
- **Editable sheet rows**: Purpose (title/priority), When (day/times), Technician, Scheduling
  promise. Customer contact rows stay read-only — `update_customer` is a follow-up brief.
- **"Promise" wording split**: sheet row renamed **"Scheduling promise"**; copy disambiguated to
  "Customer was told we're coming <weekday> <date>" (user confirmed `promised_day` = the
  visit's day, not when the telling happened).
- **Customer notes = compressed standing facts**, read-only, BOTH tiers (facts already reach
  technicians via the agent; no per-fact sensitivity exists — adding one is future work).
  Retraction-folded server-side, capped, values truncated.
- (impl) **Shared cores extracted, not duplicated**: the `set_promise` / `update_job` handler
  bodies (CAS + ledger event) move into shared functions both MCP and board call. Mechanism
  parity is the standing rule; hand-copying the CAS/event logic into boardApi is the failure mode.
- (impl) `move_visit` gains `unassign` (boolean) rather than a new tool — surface stays 34; the
  description change still requires fleet gateway restarts at rollout.
- **Fourth promise level: `time_only`** (user, 2026-07-23 — "told the time but not the day",
  e.g. "we'll come at 9, I'll confirm which day"). **Additive enum value, NOT a rename** (impl):
  stored `time` keeps meaning day+time — renaming it would break live writers during the
  migrate/deploy window on the pilot; the wart is internal only, UI labels translate
  (`none / day only / time only / day + time`). Semantics: `time_only` carries NO promised day
  (`promised_day` NULL — the CHECK constraint is swapped to allow it); a move breaks it when
  the START TIME changes, while the day moves freely; booking/cancel confirm gates fire like
  any promise (`requiresConfirmation = level !== 'none'`, unchanged).
- Out of scope (recorded): time-TBD visits (4b brief), autonomy toggle (4b brief),
  `update_customer` + contact editing (follow-up brief), per-fact sensitivity.

## Plain-language walkthrough

**Phase 1 — teach the system to un-assign, and to record a time-only promise.** Today the
database write that moves a visit can keep or swap the technician but cannot express "nobody".
This phase adds that ability at the bottom (DB layer), threads it through the shared move verb,
exposes it to the chat agent (`move_visit unassign:true`), and to the board's move endpoint. It
also adds the fourth promise level (`time only` — the time gates changes, the day moves
freely), which is the plan's one migration. You'd notice it working by
telling the agent "take Ben off the Whitfield visit" — the visit stays on the calendar, Ben
gets the normal "moved off your schedule" push, and the visit appears in the Unassigned lane
and the loose bucket.

**Phase 2 — give the board its missing doors.** Four small server additions: a roster list for
the picker, a book endpoint (so the tray can schedule a job), a promise endpoint, and a
job-identity endpoint — the last two by extracting the exact logic the chat tools already run.
The detail payload also grows the fields the sheet needs (jobId, priority, compressed notes).

**Phase 3 — the visible part.** The picker sheet (with "None" to park), pencil affordances on
the detail sheet rows, the tray booking form (day, start, end, technician-or-park, promise),
tappable job rows, drag-to-Unassigned goes live, and the notes section.

```
tap ✎ on sheet row ──► picker / mini-form ──► POST /board/api/…  ──► shared verb
drag card → Unassigned lane ──► POST move {unassign:true} ────────► (same verbs
tray job row → booking sheet ──► POST /board/api/book ────────────►  chat uses)
                                            │ requiresConfirmation? → one dialog
                                            ▼
                              schedule_events → Telegram pushes → board refresh
```

**Phase 4 — ship it.** One additive migration (the new promise value) applied BEFORE the
deploy, then restart the fleet gateways (tool descriptions changed), live-verify detach via
chat + SQL, hand device checks to the user.

## Secrets & env preflight

- **Phases 1–4:** none new (`BOARD_BOT_TOKEN`, `BOARD_PUBLIC_URL` already required).

## Phase 1: the detach verb + the fourth promise level

### What this phase does
Adds "set technician to nobody" at every server layer with the same guards and ledger trail as
any move, and adds `time_only` to the promise ladder. No UI.

### Changes required

**`supabase/migrations/<ts>_promise_time_only.sql`** (the plan's ONE migration)
- `alter type promise_level add value 'time_only';` (additive — old code keeps writing/reading
  its three values untouched; note ADD VALUE must not be used by the same migration's DML).
- Swap the pairing constraint: drop `promised_day_when_promised`, add
  `check (promise_level in ('none','time_only') or promised_day is not null)` (same lenient
  shape as today's `'none' or promised_day is not null`).
- Regenerate `src/db/database.types.ts` — the enum union widens and the compiler then finds
  every site that must decide about `time_only`.

**`src/schedule/booking.ts`** (ladder logic — single home)
- `resolveMove` promiseBroken (~:432-439): `day` → dayChanged; `time` → dayChanged ||
  timeChanged; **`time_only` → timeChanged only** (dayChanged is never consulted — its
  `promised_day` is NULL).
- promisedDay stamping in `bookVisit`/`moveVisit`/`setVisitPromise`: NULL for
  `'none' | 'time_only'`, the visit's date otherwise (three sites, one predicate — add a
  `carriesPromisedDay(level)` helper so they can't drift).
- `MoveVisitPreview` += `promiseLevel` so surfaces can phrase the confirm ("was told 09:00"
  vs "was told Thursday").

**`src/mcp/server.ts`** — `book_visit`/`set_promise` promiseLevel enums += `'time_only'`;
descriptions explain it ("told a time but not the day — the time gates changes, the day moves
freely"); `isPromiseLevel`'s `PROMISE_LEVELS` array widens (compiler-forced).

**`src/db/assignments.ts`**
- `RescheduleInput.technicianId?: string | null` — `null` = detach, `undefined` = keep.
- In `rescheduleAssignment` (~:164): `technicianId: input.technicianId !== undefined ?
  input.technicianId : old.technician_id` (the `promisedDay` idiom two lines down; the current
  `??` is exactly what made detach impossible).

**`src/schedule/booking.ts`**
- `MoveVisitInput.unassign?: boolean`. In `resolveMove`: refuse `unassign && technicianRef`
  ("pass one: a technician to attach, or unassign to park"); when `unassign`, target technician
  = null (skip the overlap pre-check — NULL rows are exempt from the DB guard).
- Person-less duplicate guard: when the RESULT will be person-less (`unassign`, or an
  unassigned row moved with no ref), run the same identical-duplicate refusal `resolveBooking`
  uses (same customer + exact window, excluding the moved row itself) — a detach must not
  silently duplicate an existing parked visit.
- `moveVisit`: pass `technicianId: null` when `unassign`; event stays kind `moved` (boardNotify
  already handles the old-person push via `previousAssignmentId` and skips the person-less new
  row — verify with a test, change nothing).
- `MoveVisitPreview` gains `unassign: boolean` so surfaces can phrase the confirm correctly.

**`src/mcp/server.ts`**
- `move_visit` inputSchema + handler: `unassign` (boolean); description gains: "unassign:true
  parks the visit — pulls the person off, keeps day/time; find it under get_team_schedule
  unassignedOnly or the board's loose bucket." Result phrasing covers the detach case.
- **Staged-confirm replay must carry it** (review finding #1): the promise-breaking path
  stages `{assignmentId, date, startTime, endTime, technicianRef, reason}` (~:3035-3044) and
  replays it into `moveVisit` at confirm time (~:3092-3103) — persist `unassign` in the staged
  detail and thread it into the replay, or a confirmed cross-day park of a promised visit
  silently commits a plain move that KEEPS the technician (preview ≠ commit on the one gated
  path).

**`src/telegram/boardApi.ts`**
- move route: accept `unassign: true` in the body; 400 when combined with `technicianRef`;
  thread into the shared input for both preview and commit.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (610/610, 2026-07-23)
- [x] new tests: DB-layer null-detach; moveVisit unassign → row `technician_id` NULL +
      `moved` event with `previousAssignmentId`; unassign+ref refusal; person-less duplicate
      refusal; promise-broken unchanged by detach (same day/time → one-shot); boardNotify emits
      exactly one push (old person) for a detach; MCP + board-endpoint passthrough & 400s
- [x] **staged-confirm detach test** (named — review finding #1): promise-breaking cross-day
      park → needs_confirmation → confirm with confirmId → row `technician_id` IS NULL
- [x] `time_only` tests: book/set_promise with `time_only` → `promised_day` NULL (constraint
      accepts); move to a DIFFERENT DAY same start time → one-shot, promiseBroken false; move
      changing start time → needs_confirmation; existing three-level tests untouched
- Phase-1 note: the migration is TWO files (`20260723090000` ADD VALUE +
  `20260723090001` constraint) — a new enum value cannot be used in its own transaction;
  adversarial review round 1: one minor finding (stale error hint), fixed.

---

## Phase 2: board API — roster, book, promise, job, notes

### What this phase does
The four endpoints the UI needs, built by extraction (never duplication), plus detail-payload
additions.

### Changes required

**`src/schedule/booking.ts`** — extract shared cores from the MCP handlers (behavior pinned by
existing server tests, which keep passing):
- `setVisitPromise(tenantId, assignmentId, promiseLevel, actorRef)` — the `set_promise` body
  from `src/mcp/server.ts:4059` (status guard, server-derived promisedDay, CAS via
  `updateAssignmentPromise`, `promise_updated` event). Returns `{updated, from:{level,day}}`.
- `updateJobIdentity(tenantId, jobId, {title?, jobType?: string|null, priority?}, actorRef)` —
  the `update_job` core from `:3979` (tenant guard, CAS `updateJobDetails`, `job_updated`
  event). **jobType (incl. null-to-clear) is part of the core** (review finding #2 — the MCP
  handler writes it and tests pin it; a title-only core would force the handler to keep a
  parallel CAS+event path). The `findJobTypeDurationMinutes` warning stays MCP-side; the BOARD
  endpoint restricts its body to title + priority.
- MCP handlers keep their validation + echo composition and call the cores.

**`src/db/assignments.ts`** (review finding #3 — this file changes in Phase 2 too)
- Widen `DETAIL_SELECT` (~:291) with `customers.attributes` + `jobs.priority`, and the
  `AssignmentDetailRow` Picks to match (mind the single-string-literal select constraint).

**`src/schedule/boardRead.ts`**
- `VisitDetail` += `jobId: string | null` (tenant-gated like the day path), `jobPriority`,
  `customerNotes: {key, value}[]` — attributes run through the fold pattern the capture reads
  use (`factSourceIds` → `findRetractionsFor` (`src/db/rawCaptures.ts:175`) →
  `foldRetractedFacts` → `unwrapAttributes`, all from `src/db/standingFacts.ts`; the composed
  precedent is `src/mcp/server.ts:1569-1608`, NOT grounding.ts), cap 8 entries, values
  stringified + truncated to 80 chars, server-composed. Both tiers (recorded decision).
- `readRosterForBoard(tenantId)`: `listTeam` → filter `!isInactiveState` → `[{ref, name}]`.

**`src/telegram/boardApi.ts`**
- `GET /board/api/roster` (manager-only) → `{technicians:[{ref,name}]}`.
- `POST /board/api/book` (manager-only, `?preview=1` + commit like move): body jobId, date,
  startTime, endTime, technicianRef?, promiseLevel? → `previewBookVisit`/`bookVisit` with the
  jobId path only (400 on customerId); commit returns assignmentId/day/times/promiseLevel/
  warning. Same error triage block as move/cancel.
- `POST /board/api/promise` (manager-only, one-shot): assignmentId + promiseLevel →
  `setVisitPromise`; returns old→new.
- `POST /board/api/job` (manager-only, one-shot): jobId + title?/priority? →
  `updateJobIdentity`; returns old→new per changed field.

### Automated verification
- [x] gates pass; existing `set_promise`/`update_job` MCP tests still green post-extraction
      (618/618, 2026-07-23)
- [x] new boardApi tests: tier gates (403), roster filtering (offboarded excluded, seat-exempt
      included), book preview/commit incl. promise staging + jobId-only rule, promise old→new +
      ledger event, job edit old→new, notes folded/capped/truncated + hostile-tenant re-check,
      detail jobId withheld cross-tenant
- Phase-2 note: adversarial review round 1 — no blocking findings; observation carried to
  Phase 3: never send `?preview=1` to `/board/api/promise` or `/board/api/job` (one-shot
  endpoints ignore it and commit).

---

## Phase 3: board UI

### What this phase does
All visible affordances. Manager-only rendering (server re-gates regardless); technician sheets
gain ONLY the notes section.

### Changes required

**`web/board/board.js`**
- Picker sheet component (detail-overlay pattern): lists roster (fetched on open; last list
  cached per session), busy-hint per person computed client-side from already-rendered stops
  when the visit's day is in the current window; "None (park it)" option shown when editing an
  existing visit with a technician. Selecting → POST move (attach/reassign or `unassign`) →
  toast + `refresh()`.
- Detail sheet (manager): ✎ affordances — Purpose → mini-form (title, priority) → `/job`;
  When → mini-form (date, start, end) → move flow incl. its preview/confirm; Technician →
  picker; Scheduling promise → 3-option selector (`none/day/day+time`) → `/promise`.
  Row renamed "Scheduling promise"; copy "Customer was told we're coming <weekday> <date>"
  (day levels) / "Customer was told <start time>, day not promised" (`time_only`). Promise
  selector = FOUR options: none / day only / time only / day + time (stored
  none/day/time_only/time). Stop-card badges: "promised day" / "promised time" /
  "promised day+time".
- Tray: parked-visit row gains "Assign" (picker); job rows tappable → booking sheet (day,
  start, end, technician-or-"leave unassigned", promise selector) → book preview→confirm→commit
  → toast + refresh + re-fetch bucket.
- Drag-to-park: **the Unassigned lane renders unconditionally on actionable team-layout days**
  (empty state allowed — it doubles as the drop target; review finding #4: today the lane only
  renders when a day already has unassigned stops, so the gesture would have no target on any
  clean day and fall through to a keep-the-person day move). `targetAt` returns it as
  `{unassign:true}` (drop-hover restored); `moveFlow` sends `unassign:true`, no
  `technicianRef`; already-unassigned card dropped there same-day = no-op. Confirm dialog copy
  covers the park case when a promise would break (a cross-day drag into the lane can).
- Technician tier: notes section renders; zero new write affordances.

**`web/board/board.css`** — picker rows, mini-form fields, ✎ affordance, notes section.

### Automated verification
- [x] gates pass (board.js is lint-covered); boardApi tests from Phase 2 unchanged
      (618/618 + build, 2026-07-23)
- Phase-3 review round 1 (2 findings, both fixed): (a) the time_only break dialog named the
  NEW time, not the promised one — postMove now threads the old start into breakMsg from all
  four call sites; (b) the sheet editors bypassed the board's past/read-only write gates —
  canEdit now carries the full triple gate (manager + Team tab + today-or-future), date inputs
  carry min=today, and OVERDUE tray rows lose the Assign button (board writes never target the
  past; overdue recovery stays a chat job — recorded rule, loosen deliberately if pilot use
  demands it). Round-2 verification below.

### Manual verification (device — can fold into the owed 4a phone pass)
- [ ] picker: assign a parked visit; reassign a lane card; "None" parks an assigned visit
- [ ] drag a card onto Unassigned → parks; pill count rises; overdue behavior unchanged
- [ ] tray: book the garage-sink job with times + promise "day" → confirm dialog → lands on
      board; pill drops
- [ ] sheet edits: title, priority, times, promise each round-trip with old→new toast
- [ ] technician phone: notes visible, no ✎/picker/drag anywhere

---
*Pause after Phase 3 for the device checks.*

## Phase 4: rollout

### Changes / steps
- [x] **Migration FIRST, then deploy** — applied to the pilot 2026-07-23 BEFORE the deploy
      (correct order this time): both files via MCP apply_migration; read-backs: enum =
      `{none,day,time,time_only}`, constraint def =
      `promise_level IN ('none','time_only') OR promised_day IS NOT NULL`; PostgREST schema
      reloaded. Old code runs clean through the window (additive value).
- [x] PR (research + plan docs committed alongside), user merges, Render deploy — #74 merged
      2026-07-23 09:30Z, #75 merged 17:58Z; deploy freshness VERIFIED (Redeploy-old-commit
      trap): `GET /board/static/board.js` on tradesdatabase.onrender.com byte-identical to
      merged main (63,767 bytes, 14 `park it`/`Scheduling promise`/`time_only` marker hits)
- [x] detach itself needs no schema change (`technician_id` already nullable)
- [x] Fleet gateway restarts 2026-07-23 — enumerated FROM the box (`nemoclaw list`): s2, s3,
      s5, s7 live (s6 cold blank, no bot token — skipped); all four restarted, each
      "✓ Gateway restarted; health passed; forwards checked/recovered"; `channels status`
      [ok] on s2 + s5 post-restart
- [x] docs: `move_visit` unassign line in `docs/nemoclaw-tech-agent.md` (count stays 34) —
      rode the final-review commit ece7d4e

### Live verification (agent-executable)
- Prerequisites: supabase-test MCP (read-backs), ssh to trades-box-1
- [x] chat probe 2026-07-23 (s2, fresh CLI session `probe-4a5-detach`): "Take Hman off the
      Maria Gonzalez visit on July 30 … keep the visit on the calendar" → agent parked it
      one-shot. SQL read-back: old row `642e8e8c` → `cancelled` (technician kept for
      history), new row `f7fc947f` → `confirmed`, `technician_id` NULL, same 14:00–16:00
      window; `moved` event `{fromDay: 2026-07-30, toDay: 2026-07-30, promiseBroken: false,
      previousAssignmentId: 642e8e8c…}`. Reverse probe ("put Hman back") → attach path:
      row `fc118126` confirmed with hman, parked count back to baseline — pilot data
      restored to pre-probe state.
- [x] SQL bucket parity (the REAL predicates: parked = confirmed + technician NULL,
      unbounded; jobs = status 'open' + no proposed/confirmed row): 1→2 parked (new row
      present in `parked_ids`) + 5 unscheduled jobs = pill "Loose: 6"→"Loose: 7" during the
      probe, back to 6 after restore. (First parity attempt with a hand-written jobs
      predicate miscounted 6 — exactly the drift the shared-predicate finding predicted.)
- [x] restart evidence per sandbox recorded above
- Probe-mechanics caveat (recorded for honesty): the CLI turn fell back to the EMBEDDED
      agent ("gateway closed (1008): pairing required" — the box CLI device isn't
      gateway-paired), so the probe exercised deployed Render code + doorman + badge +
      live agent tool choice, but NOT the restarted gateway's own tools/list cache; that
      cache is lazily refreshed and rides the health-passed restarts, and the user's first
      real Telegram ask re-verifies it. Also observed: `[agent/embedded] AGENTS.md is
      21541 chars (limit 12000); truncating` — embedded-CLI turns truncate AGENTS.md, so
      never judge AGENTS.md-dependent behavior (board links, batching rules) from CLI
      probes; Telegram-path behavior is the authority.

### Manual verification
- [ ] user confirms the Phase-3 device list on the pilot board

#### 4a.6 board polish — BUILT 2026-07-23 (branch `feature-4a6-board-polish`)
All five findings below are fixed; gates green (620/620, +1 new test). No migration, UI +
one test only. Server behavior unchanged except the audit-reason wording board writes send.
- (1) latency → roster warm-up right after the manager's board paints (de-duplicated with
  an in-flight promise so a picker opened mid-flight reuses it), and the picker now dismisses
  on tap instead of hanging through preview→commit. The preview→commit pair itself STAYS —
  it is the confirmation doctrine, not overhead.
- (2) vocab → "Unassigned visits" in the tray, "None — leave unassigned" in the picker,
  "Leave unassigned" in the booking sheet, "now unassigned" toasts, audit reasons
  "Unassigned on the …". The wire key `parkedVisits` and the `unassign` verb are unchanged
  (contract + action word).
- (3) unscheduled-job editing → `openJobForm` extracted as ONE body for both entry points;
  the tray job row gained an Edit button. Pinned by a new test: a job with NO visit edits in
  place, the tray reflects the new title, and no visit is minted.
- (4) the missing-pencils bug → **two independent causes**, both closed. (a) the tab term
  dropped from `canEdit`; (b) `visibilitychange` nulls `state.today` to force re-learning the
  firm-local day, but a FAILED refresh left it null over an already-rendered board — every
  sheet gate reads it, so all editing went read-only while the cards behind still looked
  editable. The anchor is now restored when the re-anchor doesn't land (safe: the server
  floors past-dated board writes, so a stale-by-one-day anchor can only cost a refused
  write). Cause (b) fires on ANY tab, including Team — it is the candidate if the user was
  not on "My schedule". Read-only sheets now state the reason (`.sheet-note`), so neither
  cause can present silently again.
- (5) `busyHint` "free" → "available".

#### Device-check results (user, 2026-07-23)
PASSED on the pilot board: drag-to-park, tray booking, editable sheet round-trips,
compressed customer-notes section, past-write guard (no affordances on past days / Mine tab).

Findings → all folded into the **4a.6 board-polish** follow-up:
1. **Tap-assign latency** — the picker→assign gesture feels slow. Candidate causes: roster
   GET on every picker open (not cached across opens), the sequential
   preview→commit→full-`refresh()` chain (three round-trips before the card moves), and
   Render cold-start. Fix shapes: cache the roster per session, optimistic lane update, or
   patch the moved card from the commit response instead of reloading the whole board.
2. **"Parked" vs "Unassigned" — USER DECIDED: unify on "Unassigned."** They are the same
   state (`technician_id NULL`, confirmed); the two names read as two concepts. The real
   difference is scope, not state (lane = person-less visits on the viewed day + drop
   target; tray = person-less visits ANY day, incl. beyond the window/overdue, PLUS jobs
   with no visit at all). Rename "parked visit" → "unassigned visit" in board copy;
   `unassign` stays the verb name (it is an action, not a state).
3. **Unscheduled jobs cannot be edited without scheduling them first** — the tray job row
   taps straight into the booking sheet; title/priority editing lives only on a *visit's*
   detail sheet. `POST /board/api/job` is jobId-keyed and would already serve an
   unscheduled job — the UI just never offers it. Fix: an edit affordance on the job row
   (or an "edit details" step inside the booking sheet).
4. **Unassigned visits open a sheet with NO ✎ at all** (user, confirmed on device — the
   sheet opens, the pencils are absent). `canEdit` (board.js:640) never tests for a
   technician, and the live rows are all `confirmed` + future with tenant-valid jobIds, so
   the failing term is **`state.view === 'team'`**: the loose-bucket pill renders for
   managers on BOTH tabs (board.js:302), so opening the tray from **My schedule** yields a
   sheet gated read-only — while an assigned visit, tapped from a lane, is only reachable
   on the Team tab and therefore always edits fine. Compounding: out-of-window unassigned
   visits (2 of 3 on the pilot) are reachable ONLY via the tray, so the tray is exactly
   where this bites. **Fix: drop the tab term from `canEdit`** — it carries no safety that
   the remaining terms don't (manager tier + `confirmed` + today-or-future, with the server
   re-gating tier AND the past-date floor); it was belt-and-braces from Phase-3 review
   finding #2, whose actual protection is the date term. **Plus: a read-only sheet must SAY
   why** (one muted line — "Past visit — read-only", etc.) instead of silently omitting
   affordances; silent omission is what made this look like a missing feature. Also give
   tray visit rows the job row's "tap to …" hint.
5. **Picker busy-hint copy: "free" → "available"** (user) — `busyHint`, board.js:824.

## Final review gate
Bundled `/code-review` on the full diff; Important findings fixed + gates re-run before the
plan flips to `complete`.

**RUN 2026-07-23 — 8 angles (line-scan / removed-behavior / cross-file / reuse /
simplification / efficiency / altitude / conventions), ~35 candidates → deduped. FIXED
(619/619 after):**
- The `'time'`-as-only-non-day ternary class, three more sites: cancelFlow's confirm dialog
  described a time_only cancel as "promised a day" (named the actual stake per level);
  breakMsg printed "promised day (X → X)" for a same-day time change of a day+time promise
  (time-break branch added); the MCP confirm-note claimed "a different day" for any break
  (level-agnostic copy).
- Tool-description drift: book_visit/cancel_visit confirm triggers under-listed the levels
  ("any promiseLevel other than none" now); get_team_schedule's promiseLevel enumeration +
  the doorman-runbook/engineering-memory ladder lines gained time_only.
- busyHint claimed "free" from Mine-tab (self-filtered) data — stopsByDate now stored only
  from team-layout renders.
- One-shot verbs (/promise, /job) silently COMMITTED on ?preview=1 — now 400 "has no preview".
- Server-side past-date floor on board move/book (firm-local today; board-only — chat keeps
  its deliberate-correction path); board writes' audit reason now tracks the actual action
  (a parked card day-moved via the Unassigned lane was stamped "Parked").
- book endpoint refuses stray `priority` (MCP parity — never report an unstored urgency as
  stored); failed book commit now refreshes (raced-overlap staleness, move-flow parity).
- Consolidations: ONE `listIdenticalUnassignedVisits` embedded query replaces both
  hand-copied person-less duplicate scans (kills the N+1 getJob loop + a dead condition;
  move-path reads parallelized); promiseBroken derived from carriesPromisedDay/
  carriesPromisedTime predicates (a future fifth level can no longer silently classify as
  promise-safe); unassign flag spelled one way at all three server sites; stale "lane is a
  drag SOURCE only" comment corrected; migration comment cites the Postgres ALTER TYPE doc.
**Surfaced, deliberately NOT done (nit tier / follow-ups):** retrofitting openDetail/
openBucket onto the new openSheet helper; consolidating the 5 retraction-fold copies
(boardRead + 3×server.ts + db/context.ts) into one shared helper — follow-up item;
generalizing postMove/book/cancel into one postWrite flow; the unassign boolean vs nullable
technicianRef tri-state (boolean kept deliberately — LLM-caller ergonomics); a narrow-select
findRetractionsFor variant; sheet re-fetch after promise/job edits (could patch from the
response).
