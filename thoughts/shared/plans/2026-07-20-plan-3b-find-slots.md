---
date: 2026-07-20
task: Plan 3b — find_slots: the deterministic, horizon-aware, drive-aware feasible-slot finder (read-only, ranked, no dead ends). Stacked on Plan 3a.
research: thoughts/shared/research/2026-07-20-plan-3-auto-scheduler-surfaces.md + thoughts/shared/research/2026-07-20-flexible-scheduling-agent-toolset.md
status: draft
---

## Overview

The one missing capability class is MEASURE: nothing computes "does this job fit into this
person's day, and what does it cost." `find_slots` is the deterministic measuring tool the
agent composes with the existing placing verbs (book/move/cancel): it returns ranked,
pre-scored candidate slots with human-ready reasons, and when nothing fits it returns the
binding constraint plus what could move — never a dead end. It writes nothing. Feasibility
becomes a tool verdict, never the model's opinion (the load-bearing rule from the agent
research). Depends on Plan 3a's data (patterns, durations, skills, priority) — stacked,
3a first.

## Decisions

- **`find_slots` is the ONLY new tool; no `schedule_job` wrapper** — the agent composes
  find → present → manager picks → `book_visit`. Rationale: one write path keeps the
  confirmation doctrine single-sourced; product precedent is suggestion-then-approve; tool
  budget stays small. Revisit if pilot latency (two agent turns) annoys the manager.
- **DENSITY-aware mode, not calendar-aware** (user correction 2026-07-20: "closeness was
  only ever a proxy — days near today TEND to be packed; the real driver is how packed the
  day is"). Per (technician, day): ≥ `DENSE_DAY_STOPS` (2) existing visits → GAP-FILL mode
  (one concrete candidate per fitting gap; drive delta measurable — the ≥2-stop
  measurability boundary and the mode boundary are the same line); fewer → OPEN-DAY mode
  (ONE day-level candidate, suggested window = first fitting gap, quoted as a DAY — times
  on a loose day are false precision; the route will reshape). Calendar distance keeps
  exactly two roles: the EARLINESS score (urgency wants the soonest day — that's priority,
  not packedness) and the day-0 now-clamp. Refinement trigger recorded: if stop-count
  proves too coarse (one 8-hour visit = "1 stop" but a tight day), switch the threshold to
  booked-fraction of the working window. Default range today..today+13 = 14 inclusive days
  (house span idiom, `spanDays ≤ 14`, server.ts:2279-2286 — review finding #3). The Routes
  client is the gap-fill measuring tape; whole-plan optimization (ROI API) is Plan 4's
  freeze — recorded split (user).
- **Duration is fail-closed** (user): explicit `durationMinutes` arg, else the job-type
  table via a NEW `findJobTypeDurationMinutes(tenantId, jobType): Promise<number|null>`
  helper (review finding #2 — `getJobDurationMinutes`'s tenant-default branch is the exact
  forbidden path; a null from the new helper → error instructing the agent to ask the
  manager). Never 120. Untyped job / customerId path gets its own error variant ("this job
  has no type — ask the manager how long it takes and pass durationMinutes").
- **Duration errors CARRY the tenant's configured vocabulary** (user concern 2026-07-20:
  free-text job types arrive in many phrasings, and new types appear mid-scheduling). The
  server never fuzzy-matches (a wrong match silently books a wrong-length job); instead the
  no-duration error lists every configured type + minutes ("Configured types: install
  (480m), maintenance (60m)… if this is one of those, use that type; otherwise ask the
  manager"), so the AGENT does the language-level mapping with the choices in hand — no
  dead end, no memorization. A stated general rule gets stored via set_job_duration (one
  question per new type, ever); one-off durations ride the durationMinutes override.
- **Misclassification defenses** (user concern 2026-07-20: agent maps an install to a
  repair): (a) type + duration are fused into each candidate's SERVER-composed reason
  string ("Tue with Bob, 8:00–16:00 — 8h install") so disclosure survives a lazy relay and
  the slot WIDTH itself exposes a wrong duration pre-commit (find_slots cannot book —
  manager always sees options first); (b) a job row that already carries job_type is
  AUTHORITATIVE — agent classification applies only to untyped jobs, and overriding a
  typed job's duration requires the explicit durationMinutes arg (echoed as "using your
  stated Nh, not the stored table value"); (c) agent classifications return labeled as a
  guess (`assumedType` + "my reading of '<title>' — say otherwise"); (d) recorded
  limitation: the confirmed mapping is NOT persisted onto the job in v1 (find_slots is
  read-only; no job-type editor exists) — an untyped job re-asked later is re-mapped;
  revisit if the pilot shows repeats.
- **Stored durations are DISCLOSED, never silent** (user concern 2026-07-20 — the endTime
  lesson generalized: manager-stated-once data is fine, silent use of it is not): every
  find_slots result that resolved duration from the table carries
  `durationAssumption: "assuming <N> min for '<type>' (from your set_job_duration setting)
  — pass durationMinutes if this job differs"` in the payload (mechanism over instruction);
  an explicit `durationMinutes` arg always beats the table. Also in 3b's server.ts pass:
  reword set_job_duration's result note "default to" → "assumed to take … unless a
  different duration is stated".
- **Drive measurement is bounded**: only the top `DRIVE_MEASURE_TOP` (5) near candidates
  after pre-scoring get computeRoutes calls (2 calls each: day-with vs day-without; a
  <3-stop day measures with-only and reports the delta as "route becomes X min"). Billing
  stays pennies; the cap is stated in the result (`driveMeasured: true|false` per candidate).
- **Availability fail-closed carries through**: pattern-less technicians are simply absent
  from candidates; the result names them (`skippedNoPattern: [refs]`) so the agent can say
  "set Bob's hours to include him" — surfaced, not silent.
- **Skills gate via optional `requiredSkills` arg, with unknown ≠ unqualified** (user
  concern, 2026-07-20: incomplete skills data must never silently starve a technician of
  work). Three-state semantics: no `requiredSkills` in the ask → skills never filter;
  tech with an EMPTY skills list (never configured) → INCLUDED as a candidate, flagged
  "skills not configured — confirm they can do <skill> before booking"; tech with a
  non-empty list lacking the skill (an explicit manager statement) → excluded AND named in
  `skippedSkills`. Exclusion is only ever earned by configured data, and never silent.
  No job→skills mapping exists yet (recorded limitation).
- **Customer facts ride in the payload**: the customer's unwrapped L3 attributes
  (`unwrapAttributes`, retraction-filtered like get_customer_context) return as
  `customerFacts` so "only mornings" is in front of the agent — data-in-result
  (mechanism over instruction), not a hard constraint in v1.
- **Scoring components (fixed, documented, no ML)**: earlier-date bonus scaled by
  `jobs.priority` (emergency/urgent steep, maintenance flat); morning-gap bonus for
  routine/maintenance (front-load doctrine; afternoons stay loose for emergencies); light-day
  bonus (load balance); same-city bonus (customer.city vs that day's existing stop cities or
  the tech's service_cities); drive delta subtracts. Weights are constants in fit.ts with a
  comment table; tests pin the ordering, not the raw numbers.
- **No-fit result = binding constraint + nearest alternatives + displacement candidates**
  (promise-'none' visits first, each labeled locked/promise/day) — informational in v1;
  the agent acts on them via `move_visit` (reflow_day batch verb DEFERRED — user,
  2026-07-20).
- **Unassigned-visit placement included**: `assignmentId` may be passed instead of a
  customer/job — candidates for an existing (typically unassigned) visit's duration
  (`ends_at − starts_at`, a real value that correctly bypasses the duration error), so
  "who can take this parked visit" is the same tool. Subject must be `confirmed`/`proposed`
  (mirror booking.ts:395-397); the subject's own row is EXCLUDED from the day-stop context
  (excludeId precedent, booking.ts:98-106) so an assigned subject doesn't block the gaps it
  would vacate (review finding #8).
- **Every emitted slot must be bookable by `book_visit` verbatim**: a gap ending at a
  `24:00` window edge emits endTime `23:59` (the `addMinutesClamped` clamp, booking.ts:55-59)
  because `book_visit` rejects `24:00` (review finding #1); day-0 gaps are clamped to the
  server's firm-local "now" so afternoon asks never rank already-past morning slots (review
  finding #6 — `now` is an engine input, server-supplied like resolve_date's today).
- **`scheduleVersion` rides in every result** (read before snapshot); no version-pinned
  writes in this plan (that machinery deferred with reflow_day).

## Plain-language walkthrough

**Phase 1 — the gap math.** A pure module computes each person's free gaps on a day:
working windows minus time off minus booked visits. No network, no AI — heavily unit-tested
minute arithmetic on the naive-local times the schedule already stores.

**Phase 2 — the measuring tape.** For near-term candidates, one Google call answers "what
does this day's driving become if we add this stop." The difference is the drive cost of
that candidate, and it rides into the score.

**Phase 3 — the tool.** The agent gets `find_slots`. Ask "when can we fit the Hendersons'
8-hour install?" and the result is up to five ranked options, each with a one-line reason
("Tue with Bob — free 8–17, +12 min drive, same street as the Chen job"), plus who was
skipped and why, plus — when nothing fits — what could move to make room.

```
 manager ──► agent ──► find_slots(customerId, requiredSkills?, dates?)
                          │ fit engine → score → top-5 drive-measured
                          ▼
             {candidates: [...ranked, human-ready...], noFit?, displacement?,
              skippedNoPattern, customerFacts, scheduleVersion}
                          ▼
             agent presents options ── manager picks ──► book_visit (existing)
```

**Phase 4 — ship it.** Deploy, refresh the sandboxes' tool caches, then a live E2E: set a
pattern via 3a's verbs, ask the agent for slots, verify the numbers against the database.

## Secrets & env preflight

- **Phase 1:** local stack only (already required).
- **Phase 2:** `GOOGLE_MAPS_API_KEY` in `.env` for the one key-gated live test (skipped when
  absent — existing idiom); tests otherwise inject a fake `ComputeRoutes`.
- **Phase 3:** none new.
- **Phase 4:** `GOOGLE_MAPS_API_KEY` present on the **Render web service** (dashboard check
  — open question from research whether it's set; if missing, find_slots degrades to
  driveMeasured:false, which the E2E must then expect); box SSH for wire + gateway restarts.

## Phase 1: Fit engine (pure)

### What this phase does
`src/schedule/fit.ts` — gap computation, candidate generation, scoring. No I/O in the core
functions; a thin DB-composing wrapper.

### Changes required

**`src/db/jobTypeDurations.ts`** (+ `src/db/index.ts` export)
- NEW `findJobTypeDurationMinutes(tenantId, jobType): Promise<number | null>` — normalized
  row read, null when unconfigured; NO tenant-default fallback (review finding #2).

**`src/schedule/fit.ts`** (new)
- `dayWindows(pattern, dateISO): [string,string][]` — the day's working windows via
  `localDayOfWeek(date, 'UTC')` (naive-local convention), '24:00' end handled.
- `freeGaps(windows, visits: {start,end}[], durationMin, notBefore?): Gap[]` — subtract
  visits (HH:MM minute math), return gaps ≥ duration; `notBefore` (day-0 "now" clamp) trims
  gap starts. Visits are clamped by OVERLAP with the day, not start-day, so a
  backfill-sourced row spilling past midnight still blocks the morning (review finding #7).
  Slot endTime emitted as `23:59` when the window edge is `24:00` (bookability, finding #1).
  Overnight windows are two windows already (WeeklyPattern rule) — no cross-midnight logic.
- `interface SlotCandidate { technicianRef; technicianName; date; startTime; endTime;
  dayLevel: boolean; score; reasons: string[]; driveDeltaMinutes?: number|null;
  driveMeasured: boolean; warnings: string[] }`
- `generateCandidates(input)` — per active, pattern-configured, skills-matching tech ×
  day in [earliest, latest] (default today..today+13; inclusive span capped at 14): time-off
  days skipped; rows with `technician_id` null dropped from per-tech grouping (finding #8);
  DENSE day (≥ DENSE_DAY_STOPS=2 existing visits): one concrete candidate per fitting gap
  (start = gap start, day-0 clamped to `now`); OPEN day (0–1 visits): one day-level
  candidate when a fit exists (density decides the mode, never the date — user correction).
  `today` and `now` are inputs (pure engine; fake-clock tests).
- `scoreCandidates(cands, {priority, customerCity, dayStopsByTechDate})` — the Decisions
  table; returns sorted.
- `findDisplacementCandidates(tenantId, range)` — confirmed visits ordered promise-'none'
  first, each {assignmentId, customer, day, span, promiseLevel, locked, technicianRef}.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (48 files, 559 passed / 1
      pre-existing skip, 2026-07-20)
- [x] `src/schedule/fit.test.ts` (pure, no DB): gap math incl. edge-touching visits,
      '24:00' window end, gap-too-small, empty pattern day; DENSE vs OPEN candidate shapes
      at the 2-stop boundary (2 visits → concrete gaps regardless of date; 0–1 → day-level
      even tomorrow); scoring ORDER pinned for: emergency beats routine on earliness;
      routine prefers morning gap; lighter day beats heavier; same-city bonus applies;
      drive delta demotes (17 tests, commits 4a8357f + b809938)
- [x] DB-composing wrapper tests (local stack): time off excludes the day; pattern-less tech
      lands in skippedNoPattern; skills three-state pinned — requiredSkills absent → no
      filtering; empty-list tech INCLUDED with the confirm-first flag; configured-mismatch
      tech excluded AND named in skippedSkills (`src/schedule/fit.db.test.ts`, 7 tests, also
      covers offboarding-absent, technicianRef pin, confirmed-only/unassigned-null day
      context, excludeAssignmentId, displacement ordering — commit aae7556)
- [x] Phase review (2 rounds): round 1 found (a) clampRowToDay string-compared PostgREST's
      '+00:00' wire format against '.000Z' literals — midnight-aligned rows blocked the
      wrong day / produced inverted spans freeGaps dropped; (b) 3 of 5 scoring-ORDER tests
      passed vacuously via the date/startTime tiebreak. Fixed in 9442203 (instant
      comparison + wire-format tests incl. a real PostgREST round-trip; scoring tests
      rebuilt so every expected winner LOSES the tiebreak; sortCandidates exported so the
      drive-delta test exercises the real comparator). Round 2 verified by mutation
      testing: each weight zeroed → at least one test fails; Phase 1 declared clean.

### Live verification (agent-executable)
- Prerequisites: local stack.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 2: Marginal drive measurement

### What this phase does
The bounded computeRoutes integration: measure top-K near candidates.

### Changes required

**`src/schedule/fit.ts`**
- `measureDriveDeltas(cands, dayStops, deps: {computeRoutes?})` — for each of the top
  `DRIVE_MEASURE_TOP` near candidates: build the candidate day's routable stop list
  (existing stops via the `listDayStops` shapes + the new customer's `formatAddress`).
  **The new stop is always passed as an INTERMEDIATE** (positions 1..n-1, never
  origin/destination): `optimizeStopOrder` pins first/last (googleRoutes.ts:77-102), so a
  new stop at an endpoint would solve a differently-pinned problem and skew the delta
  (review finding #4). Delta = with-totalMinutes − without-totalMinutes, only when BOTH are
  measured. Existing-stop count branches (finding #5): ≥3 without → full delta; exactly 2
  without → with-route (3 stops) measured, reason "route becomes ~X min", delta null;
  0–1 without → both routes are <3-stop short-circuits (totalMinutes null, no API call) →
  `driveMeasured: false`, no route reason (the pilot's common case at 3 future visits).
  Unroutable new customer (no address_line1) → skip measurement, warning "address
  incomplete — drive not measured". API failure → candidate survives with
  driveMeasured:false (Google failure must not eat the answer — get_schedule precedent).

### Automated verification
- [x] gates pass; fake-ComputeRoutes tests: delta computed with the new stop as an
      intermediate (assert request shape); cap respected (only top K measured); the three
      existing-stop-count branches (≥3 / exactly 2 / 0–1) produce delta / with-only reason /
      driveMeasured:false respectively with NO "null min" strings; failure degrades to
      driveMeasured:false; unroutable customer warning (8 fake tests, commits dc98f8f +
      cf498e5; review round 1 clean, its cap-boundary observation implemented — over-cap
      sibling gaps absorb the cached day delta, round 2 verified the fix + no cap leak
      under rejection interleavings)
- [x] key-gated live test: one real 3-stop measurement returns a finite delta — RAN LIVE
      2026-07-20 after the user added `GOOGLE_MAPS_API_KEY` to `.env`. First run FAILED and
      exposed a REAL undocumented API behavior: `optimizeWaypointOrder` over exactly ONE
      intermediate returns sentinel `optimizedIntermediateWaypointIndex: [-1]` (docs imply
      [0]) — the permutation guard rightly rejected it, so every 3-stop route (incl.
      get_schedule 3-stop days in prod) silently degraded to unmeasured. Fixed in
      `optimizeStopOrder`: single-intermediate routes skip the optimize flag (nothing to
      reorder; identity order, legs/duration parsed normally) + fake test pinning the
      request shape and index-less response. After the fix: full suite 580 passed,
      0 skipped (both key-gated live tests included — first zero-skip run).
      **Full-conviction seeded run (evidence in-session):** dense Thursday for tech-jane
      (3 real-address Fresno visits 08:30–09:30/10:30–11:30/13:00–14:00), find_slots for a
      real-address subject → exactly ONE concrete candidate 14:00–16:00 (the only 2h gap),
      driveMeasured true, driveDeltaMinutes 7, reason "adds ~7 min of driving" — verified
      against 3 channels: SQL schedule state, and a direct two-call Google re-derivation
      (without 27 min / with 34 min → delta 7, exact match). Trap recorded in
      docs/engineering-memory.md §5.

### Live verification (agent-executable)
- Prerequisites: local stack; optional real key.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 3: The find_slots tool

### What this phase does
Manager-only MCP tool wiring the engine; decision-ready results.

### Changes required

**`src/mcp/server.ts`**
- `ADMIN_TOOLS` += `find_slots {customerId|jobId|assignmentId (exactly one), durationMinutes?,
  technicianRef?, requiredSkills?, earliestDate?, latestDate?}`. Description: what it
  returns, "NEVER judge fit yourself — this tool is the only source of scheduling truth",
  duration fail-closed behavior, and that it books nothing.
- Handler: tenant-guard the subject (customer/job/assignment — assignment path takes its
  duration + customer from the row/job); duration resolution: arg → `getJobDurationMinutes`
  (typed jobs only; its tenant-default branch must NOT be reached — call it only when a
  job_type row exists, via a direct `job_type_durations` read) → else error: "no duration
  configured for '<type>' — ask the manager how long this job takes, then pass
  durationMinutes or set_job_duration"; technician set: pinned ref (must resolve + active)
  or all `listTeam` active + pattern-configured, minus skills mismatches; assemble day-stop
  context via `listAssignmentsForTenant`; engine → score → measure → top 5; result also
  carries `customerFacts` (unwrapped, retraction-filtered — reuse the get_customer_context
  path), `skippedNoPattern`, `skippedSkills`, `searched: {technicians, days}`,
  `scheduleVersion`, and on empty candidates: `noFit: {bindingConstraint, nearestAlternatives
  (best beyond latestDate, or shorter-duration hint), displacement: [...top 5...]}`.
- `BOARD_LINK_TOOL_NAMES` (server.ts:741): NOT added — find_slots commits nothing (board
  link rides committed results only; staging precedent).

**Docs** — tool counts 30 → 31 (nemoclaw-tech-agent.md, doorman-runbook.md, setup guide).

### Automated verification
- [x] gates pass; `src/mcp/server.test.ts`: technician badge → error; exactly-one-subject
      enforced; duration fail-closed error text; untyped job + no arg → same error; typed
      job resolves table duration; pattern-less-only roster → zero candidates +
      skippedNoPattern + noFit block present; candidates ranked with reasons strings;
      assignmentId path works for an unassigned visit AND excludes an assigned subject's own
      row; cancelled subject refused; BOTH count assertions 30 → 31 (server.test.ts:1584 and
      :1988 — 3b review finding #10). Also: assumedType guess labeling + typed-job refusal,
      vocabulary-carrying errors, skills three-state through the tool, drive wiring via the
      injected computeRoutes seam, find_slots NOT carrying the board link with
      BOARD_BOT_HANDLE set (7 tool tests, commit f7e4ba4)
- [x] date-controlled test pinning the DENSITY boundary through the full tool: packed
      far-out Monday → 3 concrete gap slots; empty same-distance day → day-level (the
      "empty TOMORROW" variant is pinned at engine level in fit.test.ts — the tool runs on
      the live clock)

### Live verification (agent-executable)
- Prerequisites: local stack.
- [x] seeded local run (2026-07-20): find_slots for seeded Maria as manager-sam, assumedType
      hvac pinned to tech-jane → 5 day-level candidates, all hand-verified against SQL
      (pattern windows, time-off 07-27..29 skipped, booked 16:00–18:00 visit truncating the
      07-21 gap to 08:00–16:00, today absent via the ~18:36 now-clamp, durationAssumption +
      assumedType guess label + customerFacts riding). Script output recorded in-session;
      exit 0 = every candidate consistent.
- [x] Phase review (3 rounds): round 1 found 6 gaps — (1) drive own-row exclusion filtered
      OTHER techs' same-instant stops (→ scoped to the subject's technician via
      getTechnicianById); (2) that exclusion untested (→ pinned both directions with
      call-count + request-body assertions); (3) nearestAlternative untested (→
      fully-booked-day test); (4) displacement could propose the subject itself (→
      excludeAssignmentId threaded, filtered before the limit slice); (5)
      assumedType+durationMinutes escaped the guess label (→ label set for every
      untyped-subject use); (6) non-string args coerced-to-absent (→ rejected/invalid_range,
      pinned). Fixed in e56b096. Round 2 verified all six + found one residual: a PROPOSED
      subject could filter out a real same-instant CONFIRMED stop (listDayStops is
      confirmed-only; the overlap guard doesn't cover proposed rows) — fixed in 7fdb0e4
      with a status gate, empirically pinned (2-calls-vs-1 assertion fails unguarded).
      Round 3 confirmed clean.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 4: Pilot rollout + live E2E

### What this phase does
Deploy, tool-cache refresh, live evidence. No migration in this plan.

### Changes required
- Render web "Deploy latest commit"; verify `GOOGLE_MAPS_API_KEY` present (dashboard —
  manual); box wire (s2, s3, s5) as ubuntu + PATH export; `gateway restart` each.

### Automated verification
- [ ] `npm run build` before deploy

### Live verification (agent-executable)
- Prerequisites: pilot MCP read access; manager sandbox; Plan 3a live (patterns settable).
- [ ] E2E: via manager chat — ensure one technician has a pattern + one job-type duration
      (3a verbs); ask for slots for a real customer; verify the returned gap against
      `assignments` + `availability` via SQL read-back (evidence in both channels)
- [ ] pattern-less technician appears in skippedNoPattern in the live result
- [ ] a deliberately impossible ask (tiny window, huge duration) returns the noFit block
      with displacement candidates — screenshot + JSON

### Manual verification
- [ ] The agent's presentation of options reads naturally (user judgment on their phone) —
      including that it relays the ranked reasons rather than inventing its own

### Live E2E findings log (2026-07-21)
- **Probe 1 (drainage, day-level):** tool output verified perfect — packed Wednesday
  correctly absent, 5h durationAssumption relayed, days quoted not times, promise question
  asked before booking, ranking 07-23→24→30→27→28 matches hand-computed scores exactly.
  FINDING: the agent relabeled every candidate's weekday ONE DAY EARLY ("Sunday" for the
  Monday 07-27 slot) — it computed weekday names itself from the bare ISO dates in the
  reason strings. FIXED mechanism-level (commit a07ebcc, PR #65): server-computed `weekday`
  field + "Thu 2026-07-23 …" reason prefixes everywhere a date is emitted + description ban
  on agent calendar math. Because the description changed, gateway restarts ARE required
  after the PR #65 deploy (unlike the sentinel fix alone).

---
*Pause after Phase 4 for the manual check.*
