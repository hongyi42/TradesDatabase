---
date: 2026-07-22
task: Plan 4a — the loose bucket gets a visual home (board tray + always-visible count) + the technician visibility horizon; first slice of the freeze series
research: thoughts/shared/research/2026-07-22-plan-4-freeze-ritual-surfaces.md
status: draft
---

## Overview

The loose bucket — parked unassigned visits + open jobs with no visit — is what the Plan-4b
freeze will consume, but today most of it is invisible: the board's Unassigned lane shows only
in-window visits, and unscheduled open jobs (5 on the pilot) appear nowhere. A manager can
forget work exists. This plan gives the bucket a persistent visual home on the board (a
header count pill + a tap-open tray), gives the agent the same data (parity), and adds the
technician visibility horizon (technicians see at most N weeks ahead — default 4; beyond
that the schedule is fluid and unpublished), tunable per firm by the manager from chat.
Ships one migration (a tenants column) and one new manager tool (surface 33 → 34, so the
rollout includes gateway restarts across the live fleet).

*Length flag: ~415 lines (>300 guideline). The overage is (a) the adversarial-review fixes
kept verbatim (the five-test rework, the tier/round-trip gates) and (b) the user-requested
horizon setting folded in mid-review (migration + tool + counts) — kept in one plan because
the horizon clamp and the setting that feeds it are not separately shippable. Same call as
the 2026-07-14 plan's flag.*

## Decisions

Series-level (user, 2026-07-22 — recorded here so the chat survives; 4b/4c inherit):
- **Plan 4 splits**: 4a = bucket visibility + horizon (this plan); 4b = the freeze (Google
  Route Optimization API engine — live-doc verification is 4b's first planning step);
  4c = system sender (merged with the future "technician about to arrive" same-day
  notification — one shared sender, not two), night-before confirms, freeze-due nudges.
- **Freeze touches the loose queues only**; freeze-placed rows land unlocked/promise-free so
  later freezes may reshuffle them; manual placements stay sacred. Stretch (4b): a runner-up
  solve that prices promise-breaking (both solves share one objective; the delta is the
  "breaking this promise saves ~N drive minutes" metric).
- **Proposal staging = the house confirm-token** (quote-style), pinned to `scheduleVersion`
  at solve time — never `proposed` calendar rows.
- **Freeze trigger = both**: manager verb with per-run horizon + an automatic per-tenant
  schedule whose runs commit the SAFE subset one-shot and announce via board-bot push.
- **Technician visibility horizon is decoupled from the freeze horizon** — generous enough
  to show some fluid future ("looking 4 weeks out, techs understand it can change").

4a implementation decisions:
- **Horizon = a per-tenant setting the manager tunes from chat** (user decision 2026-07-22,
  reversing the earlier constant proposal: "the right horizon depends on the firm"):
  `tenants.technician_horizon_days` (default 28, CHECK 7–84) + one-shot manager tool
  `set_technician_horizon {weeks}` (integer 1–12 — weeks match the manager's mental model
  and leave the agent zero arithmetic beyond ×7, done server-side). Old→new echo (update_job
  style); plain update, no CAS (the setTenantSeats precedent — a settings row is effectively
  single-writer). `src/schedule/policy.ts` keeps `DEFAULT_TECHNICIAN_HORIZON_DAYS = 28` as
  the migration-default mirror. Discovery: `get_team_schedule` responses carry
  `technicianHorizonDays` so "what is it now" is always answerable.
- **The clamp keys on TIER, never on the self-filter**: the board's manager "Mine" tab uses
  `viewerTechnicianId` too — a manager narrowing to their own stops must NOT lose far weeks.
- **Clamp behavior is trim + note, not an error**: a window partly beyond the horizon
  returns the visible part plus `horizonNote`; fully beyond returns empty days + the note
  (status stays ok — mechanism over instruction, the payload explains itself).
- **Tray is manager-only** (dispatch authority; techs don't place work). Unscheduled-job rows
  are display-only in v1 (no job detail view exists on the board); parked-visit rows open the
  existing visit detail sheet.
- **Bucket data loads AFTER the day view renders** (async pill fill) — the board-latency
  doctrine (PR #70): nothing new on the button path.
- **One bucket shape for both surfaces**: server emits `date`/`weekday`/`startTime`/`endTime`
  HH:MM slices (the PR #72 rule — raw timestamptz never leaves the server in new payloads),
  consumed verbatim by board and agent.
- **Agent parity rides the existing tool**: `get_team_schedule` `unassignedOnly:true` gains
  `unscheduledJobs` (+ an in-payload note). Result-shape only, description unchanged → no
  gateway restarts.
- **Board pushes are NOT horizon-gated** (recorded limitation): a tech may be pushed "new
  visit 2026-09-01" they cannot yet see on the board — a heads-up, not a leak; revisit in 4b.

## Plain-language walkthrough

**Phase 1 — the data.** One new read that answers "what's loose?": every future visit with
nobody attached (however far out) and every open job with no visit at all, each with the
customer's name. The board gets it at a new address (`/board/api/bucket`, managers only), and
the agent's existing "show me unassigned" view now includes the jobs half too — board and
chat can never disagree about what's loose.

**Phase 2 — the tray.** The board header (managers only) gains a small pill: `Loose: 6`.
It fills in right after the board paints, so the board stays as fast as it is today. Tapping
it slides up a tray — same sheet style as tapping a visit — with two sections: *Parked
visits* (tap one → its normal detail sheet) and *Unscheduled jobs*. The pill is the
can't-forget signal; `Loose: 0` is the all-clear.

```
 ┌──────────────────────────────┐
 │ Dispatch board    [Loose: 6] │ ← always visible (manager)
 │ [Team] [My schedule]  ‹ week ›│
 ├──────────────────────────────┤        tap pill
 │  Mon · lanes…                │  ──►  ┌─────────────────────┐
 │  Tue · lanes…                │       │ Parked visits (1)   │
 │  …                           │       │  Aug 12 · Chen …    │ → detail sheet
 └──────────────────────────────┘       │ Unscheduled jobs (5)│
                                        │  water heater · Diaz│
                                        └─────────────────────┘
```

**Phase 3 — the technician horizon.** Technician-tier schedule reads (their chat
`get_schedule` and their board view) stop at today + the firm's horizon (default 4 weeks).
Asking beyond it isn't an error — the answer comes back trimmed with a plain note: "the
schedule past <date> isn't published yet." Managers see everything, including on their own
"Mine" tab — and can retune the horizon anytime by saying so ("let techs see 6 weeks out"
→ `set_technician_horizon`, which echoes old → new).

**Phase 4 — ship it.** Pilot migration (with your explicit go-ahead) → Render deploy →
gateway restarts across the live sandboxes (new tool), then live checks with the pill
counts verified against the database.

## Secrets & env preflight

- **Phase 1:** local Supabase stack (`.env.test`) — already required. No new secrets.
- **Phase 2:** none.
- **Phase 3:** none.
- **Phase 4:** `mcp__supabase-test__apply_migration` (connected MCP) — **pilot migration
  requires the user's explicit authorization naming the change** (standing rule); Render
  deploy access ("Deploy latest commit", never "Redeploy"); box SSH for gateway restarts
  (`export PATH="$HOME/.local/bin:$PATH"`; enumerate live sandboxes FROM THE BOX —
  engineering-memory §5 fleet-rollout trap). `BOARD_BOT_TOKEN`/`BOARD_PUBLIC_URL` unchanged.

## Phase 1: Bucket data + API + agent parity

### What this phase does
The one read for "what's loose", exposed to the board (new endpoint) and the agent
(existing tool's recall view).

### Changes required

**`supabase/migrations/20260722<HHMMSS>_technician_horizon.sql`** (new)
```sql
alter table tenants add column technician_horizon_days int not null default 28
  check (technician_horizon_days between 7 and 84);
```
Apply locally (`npx supabase migration up`), regen types with
`npx supabase gen types typescript --local` (NOT `npm run gen:types` — pilot lacks this
migration until Phase 4). **Row-factory sweep:** the regenerated `Tenant` Row type makes
the column required — grep `=> Tenant` / `as Tenant` casts and add
`technician_horizon_days: 28` (the seat_exempt ripple precedent).

**`src/db/tenants.ts`**
- `setTechnicianHorizonDays(tenantId, days): Promise<Tenant>` — plain update returning the
  row (mirror `setTenantSeats`, :66-80). The CHECK constraint backstops range.

**`src/db/assignments.ts`**
- New select constant + lister (single string literal — see the DETAIL_SELECT type-inference
  note at :287-290):
```ts
const BUCKET_SELECT =
  '*, jobs(id,tenant_id,title,customer_id,customers(name,tenant_id))';
export type AssignmentBucketRow = Assignment & {
  jobs: (Pick<Job, 'id' | 'tenant_id' | 'title' | 'customer_id'> & {
    customers: (Pick<Customer, 'name' | 'tenant_id'>) | null;
  }) | null;
};
export async function listUnassignedAssignmentsWithRefs(
  tenantId: string, fromISO: string,
): Promise<AssignmentBucketRow[]>
```
  — filters exactly like `listUnassignedAssignments` (:389-403: tenant, `technician_id is
  null`, status confirmed, `starts_at >= fromISO`, ascending), embedded graph instead of
  bare rows. Callers re-check nested tenant_ids (the :258-265 security note).
- New `listUnscheduledOpenJobsWithCustomer(tenantId)`: like `listUnassignedOpenJobs`
  (:408-425) but the select adds `customers(name,tenant_id)`; same JS anti-join on live
  assignments; returns `(Job & {customers: {name, tenant_id} | null})[]`. The existing
  function stays untouched (tests/seed use it).

**`src/schedule/policy.ts`** (new, Phase 3 uses it — created here so imports are stable)
```ts
// Default technician visibility horizon (user decision 2026-07-22): beyond it
// the schedule is fluid (pre-freeze) and unpublished. Per-tenant on
// tenants.technician_horizon_days (manager-tunable via set_technician_horizon;
// this constant mirrors the migration default for callers holding no tenant
// row). Decoupled from the freeze horizon; managers are never clamped.
export const DEFAULT_TECHNICIAN_HORIZON_DAYS = 28;
```

**`src/schedule/boardRead.ts`**
- New `readLooseBucket(tenantId): Promise<LooseBucket>`:
```ts
export interface LooseBucket {
  parkedVisits: { assignmentId: string; date: string; weekday: string;
    startTime: string; endTime: string; customer: string | null;
    jobTitle: string | null }[];
  unscheduledJobs: { jobId: string; title: string | null; customer: string | null;
    priority: string; createdAt: string }[];
}
```
  — composes the two new listers; `fromISO` = firm-local today (tenant tz via `getTenant` +
  `localDateISO`, the :68-71 idiom) as `${today}T00:00:00.000Z`; per row re-check
  `jobs.tenant_id`/`customers.tenant_id` === tenantId before surfacing name/title (withhold,
  don't drop the row); `weekday` via `weekdayLabel` (import from `./fit.js`); times as
  `starts_at.slice(11,16)` slices (PR #72 rule).

**`src/telegram/boardApi.ts`**
- New route after `/board/api/visit` (:235): `GET /board/api/bucket` — `authBoard`, then
  `tier !== 'manager'` → 403 `{error:'managers only'}` (the :251-254 idiom), else
  `json(res, 200, await readLooseBucket(auth.tenantId))`.

**`src/mcp/server.ts`** — `get_team_schedule` handler, unassignedOnly arm only (:2581-2582,
return at :2641-2643): also call `listUnscheduledOpenJobsWithCustomer`; response gains
```ts
unscheduledJobs: [...{ jobId, title, customer, priority, createdAt }],
note: 'unscheduledJobs are open jobs with NO visit at all — booking one takes it off this list',
```
  (same tenant re-check; description untouched → no gateway restart).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (49 files, 599 → 600 tests
      after the review-nit fixture, all green 2026-07-22)
- [x] db tests (`src/db/scheduling.test.ts`): bucket lister returns the embedded names;
      excludes assigned/cancelled/past rows; jobs lister excludes jobs with a live
      assignment, includes priority
- [x] `src/telegram/boardApi.test.ts`: `/board/api/bucket` — manager 200 with both sections
      + HH:MM/weekday shapes; technician 403; unauthenticated 401; cross-tenant rows
      withheld (own probe tenant, self-cleaning; names withheld while rows kept).
      Bucket tests seed their OWN parked visit at a relative future date (review nit #6)
- [x] `src/mcp/server.test.ts`: unassignedOnly result carries `unscheduledJobs` + note;
      windowed mode does NOT (asserted undefined)

*Phase review (1 round, 2026-07-22): clean — two nits, both addressed: (1) an
unassigned-cancelled future fixture added so the status filter is independently
discriminated; (2) commit-hygiene note (stage explicitly; .DS_Store untracked) — applied at
commit time.*

### Live verification (agent-executable)
- Prerequisites: local stack only.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 2: The tray UI

### What this phase does
Manager header pill + tap-open tray on the board page; async fill after render.

### Changes required

**`web/board/board.js`**
- `state` gains `bucket: null` (last fetched LooseBucket or null).
- `render()` head (:267-272): for managers append
  `'<button type="button" class="bucket-pill" id="bucket-pill">Loose: …</button>'`.
- New `fetchBucket()`: `fetch('/board/api/bucket', {headers: authHeaders()})` → on ok,
  `state.bucket = body`, set pill text `Loose: N` (N = parkedVisits.length +
  unscheduledJobs.length); on failure leave `Loose: …` (silent — the pill is advisory,
  never a load blocker). Called at the end of `fetchWeek`'s success path (after `render`),
  NOT awaited, and **only when `data.tier === 'manager'`** (review gap #2: unconditional,
  it would fire a guaranteed 403 on every technician board load — `state.isManager` is set
  at board.js:357 before render, so the gate is one `if`).
- New `openBucket()` — builds an overlay reusing the detail-overlay pattern (:487-511:
  create, force reflow, `.open`; backdrop/✕ close via `closeDetail`-style handler): two
  sections with counts; parked-visit rows carry `data-id` → tap calls
  `openDetail(assignmentId)` (replace-open is already supported, :487-488); job rows have
  no tap action; empty bucket renders "Nothing loose — all work is scheduled." Rows print
  `weekday · date · startTime–endTime · customer` and `title · customer · priority`
  verbatim (no client date math — values arrive server-composed).
- Click delegation in `wireWrites()` (:712): a `.bucket-pill` branch before the card branch
  calling `openBucket()`.
- Pill refresh: `refresh()` already re-runs `fetchWeek` → bucket refetches after every
  committed load (drag-moves land on `refresh()` too, so assigning a parked visit updates
  the count).

**`web/board/board.css`**
- `.bucket-pill` (header-right, accent border, tappable), `.bucket-section h3`,
  `.bucket-row` (+ dashed left border echoing `.lane-unassigned .stop`), overlay reuses
  existing `#detail-overlay` classes where possible.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (board.js has no unit harness —
      behavior is covered by the Phase-1 endpoint tests + manual device check)

*Phase review (1 round, 2026-07-22): NO FINDINGS — verified manager-only pill/fetch paths,
overlay event isolation (body-mounted, outside #app delegation), hoisting safety,
replace-open timer safety, drag non-interaction, CSS additive-only.*

### Live verification (agent-executable)
- Prerequisites: local stack only (UI checks are device-bound → manual).

### Manual verification
- [ ] On your phone: pill visible on the manager board with the right count; tap → tray
      lists the parked visit + the 5 pilot jobs; tapping the parked visit opens its detail
      sheet; technician view (Ben device test, still owed) shows NO pill
      *(DEFERRED to Phase 4 by design — the checks need the deployed board and are
      re-listed there.)*
- [ ] Pill count updates after assigning the parked visit via drag *(same deferral)*

---
*Pause after this phase for the device check — WAIVED: the device checks require the
deployed board and are folded into Phase 4's manual list; continuing to Phase 3.*

## Phase 3: Technician visibility horizon

### What this phase does
Technician-tier schedule reads clamp at today + `TECHNICIAN_HORIZON_DAYS`; trimmed answers
carry a plain note. Managers (both tabs) unaffected.

### Changes required

**`src/schedule/boardRead.ts`**
- `ReadBoardDaysInput` += `clampToHorizon?: boolean`; `BoardDays` += `horizonNote?: string`.
- In `readBoardDays`: resolve firm-local `today` **only when `!input.from || clampToHorizon`**
  (review gap #3: hoisting it unconditionally puts an uncached `getTenant` round-trip on
  every manager board button — the PR #70 button path; managers never clamp, so they keep
  today's once-per-session behavior; the clamp path's ONE `getTenant` yields tz AND
  horizon together). When `clampToHorizon`:
  `horizonEnd = addDaysISO(today, tenant?.technician_horizon_days ?? DEFAULT_TECHNICIAN_HORIZON_DAYS)`
  (`addDaysISO` from `./fit.js`); if
  `from > horizonEnd` → return `{from, to: toDay, days: [], horizonNote: 'the schedule past
  <horizonEnd> isn't published yet — check back closer to the date'}` (the DB read is
  skipped — an unobservable optimization, not a tested behavior); else if
  `toDay > horizonEnd` → query with `toDay = horizonEnd` and attach the note. Validation
  (span cap etc.) runs BEFORE clamping, unchanged.

**`src/telegram/boardApi.ts`** — the `/board/api/day` call (:179-184):
`clampToHorizon: auth.technician.tier !== 'manager'` (tier, never the self-filter — the
manager Mine tab keeps far weeks).

**`web/board/board.js`** — `render()`: when `data.horizonNote` and the window has no stops,
show the note instead of seven "No visits" sections (a `.day-empty`-styled block); when
trimmed (note + some days), append the note under the last day.

**`src/mcp/server.ts`** — `get_schedule` handler (:1693-1767): hoist the **tz/today
computation** (:1710-1711) above the `from` default so `today` always exists; the
`from ??= today` default itself stays where it is; the CLAMP (trim `to` / empty +
`horizonNote` short-circuit) runs AFTER span validation (:1725-1727). (Review nit #5:
"hoist the default" verbatim would leave empty-args calls with `from` undefined at the
:1715 DATE test.) This tool is technician-only — managers are blocked at :1287, so no tier
test needed. Horizon value: this handler's (now-hoisted) `getTenant` row supplies
`technician_horizon_days` — no extra read.

**`src/mcp/server.ts`** — the new manager tool (this phase's reason for gateway restarts):
- `ADMIN_TOOLS` += `set_technician_horizon {weeks}` (after `set_technician_skills`):
  one-shot description ("done immediately — echo old → new; technicians can then see this
  many weeks ahead; the board and their agent both enforce it").
- Handler: non-string/…-integer rejection (`weeks` must be an integer 1–12, actionable
  error otherwise); `getTenant` → old value; `setTechnicianHorizonDays(tenantId, weeks*7)`;
  result `{status:'ok', changes: {technicianHorizonDays: {from, to}},
  note: 'technicians now see at most <N> week(s) — <N*7> days — ahead … Tell the manager
  exactly what changed (old → new)'}`. *(Implementation deviation, recorded per review
  nit #3: the echo key is `technicianHorizonDays` (day values), not the originally-specced
  `technicianHorizonWeeks` — it matches the `technicianHorizonDays` discovery field on
  get_team_schedule, so the two surfaces can never disagree on units.)*
- `get_team_schedule`: both return sites (:2641-2643) gain
  `technicianHorizonDays: tenant row's value` — the "what is it now" read; the handler
  already fetches the tenant when `from` is absent; fetch it for this field regardless
  (manager tool, not the board button path — one read is fine).

**Docs (count strings AND enumerated tool-name lists — the 3a recipe):**
`docs/nemoclaw-tech-agent.md` (manager tool count 33 → 34 + name), `docs/doorman-runbook.md`
(enumeration += set_technician_horizon), `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`
("sees 33" → 34 + name), `Box_Setup_Stuff/doorman-architecture-memory.md` ("20 admin" → 21).

Description of get_schedule untouched → its change needs no restart; the NEW TOOL does
(cached tools/list). The note IS the explanation for clamped reads.

**Existing-test rework (review BLOCKER #1 — the clamp breaks five current tests):** no
fake-clock exists in these suites, and the technician-tier fixtures use FIXED dates now
beyond today+28: server.test.ts:2118 (`G1='2026-09-14'` → "multi-day response" :2161,
"null-address stop" :2180, "optimizer failure degrades" :2260) and boardApi.test.ts:253 +
:288 (`from=2026-09-01` technician reads). Rework these to dates computed relative to the
real clock (the `localDateISO`-relative idiom at server.test.ts:2197-2213 + `addDaysISO`),
keeping each test's original semantics; the two that would pass vacuously
(:2234, :2244 — `days: []` either way) get relative dates too so their meaning survives.
ALL new horizon tests likewise use relative dates (`today+40` etc.) — a fixed fixture rots
the day it crosses the horizon.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (49 files, 602 tests, green
      2026-07-22)
- [x] the five reworked tests pass with their ORIGINAL assertions (relative dates only —
      proves within-horizon behavior is unchanged). Review round 1 found the first rework
      left two tests VACUOUS and relative fixtures able to DRIFT into fixed September
      windows (deterministic future breakage) → EVERY date fixture in boardApi.test.ts is
      now a distinct relative offset (DAY_A/B/MOVE/PROM/X1-3…) + discriminating companions
      on the technician day; round 2 verified both fixes, no new couplings — clean.
- [x] `src/telegram/boardApi.test.ts`: technician window fully beyond (today+40f) → 200,
      empty days + horizonNote; straddling → trimmed `to` (bounds-pinned) + note; manager
      same window → full data; manager `view=mine` same window → full data (the
      tier-not-selfFilter pin). (Skipped-DB-read optimization: unobservable in the
      black-box harness — not a test target, per plan-review gap #4.)
- [x] `src/mcp/server.test.ts` (`get_schedule`): beyond-horizon ask → ok + empty + note;
      straddling ask → trimmed `to` + note; within-horizon default-args ask unchanged
- [x] `src/mcp/server.test.ts` (`set_technician_horizon`): technician badge → error;
      non-integer / 0 / 13 / 2.5 / '6' → actionable error; set 6 → old→new echo + SQL
      read-back (42); at 1 week a technician read at today+10 clamps (the clamp consumes
      the SETTING, not the default); `get_team_schedule` carries `technicianHorizonDays`;
      BOTH tools/list count assertions 33 → 34; "20 admin" comments → 21

### Live verification (agent-executable)
- Prerequisites: local stack only.

### Manual verification
- [ ] none

---
*No manual checks — continue.*

## Phase 4: Migration, deploy, restarts + live evidence

### What this phase does
Pilot migration → Render deploy → fleet gateway restarts (new tool), live checks with DB
read-backs.

### Changes required
- Pilot migration via `mcp__supabase-test__apply_migration` — **STOP and get the user's
  explicit authorization naming this migration first** (standing rule), then
  `NOTIFY pgrst, 'reload schema'`. **Order is load-bearing: migration FIRST, then deploy**
  (the PR #58 deploy-before-migration incident).
- `npm run build`; Render web "Deploy latest commit".
- Box: enumerate LIVE sandboxes from the box (`nemoclaw list` + per-sandbox
  `channels status` — never a recorded map; engineering-memory §5), then
  `nemoclaw <s> gateway restart` each (new tool → cached tools/list must refresh). No
  `wire` run needed — no AGENTS.md contract lines change.

### Automated verification
- [x] `npm run build` passes before deploy (via CI gates; deploy done by user 2026-07-23)

### Live verification (agent-executable)
- Prerequisites: pilot MCP (`mcp__supabase-test__execute_sql` + `apply_migration`);
  box SSH; a manager-bound sandbox.
- [x] migration in the pilot ledger (`20260723070451 technician_horizon`); column present,
      BOTH tenants read 28 (SQL, 2026-07-23). NOTE: the user deployed BEFORE the migration
      — inverted order survived by design (reads fall back to the 28-day default; only a
      set_technician_horizon call in the short window would have errored; none occurred)
- [ ] SQL: parked=1 + unscheduled=5 (overdue=0) → expected pill "Loose: 6" — awaiting the
      user's screenshot as the second channel
- [ ] Agent chat: `get_team_schedule unassignedOnly` answer now names the unscheduled jobs
      (user relays or screenshots; SQL read-back as the second channel)
- [ ] Agent chat: "let technicians see 6 weeks ahead" → set_technician_horizon old→new
      echo; SQL read-back shows 42

### Manual verification
- [ ] Pill + tray on your phone (Phase 2 checks, on the deployed board)
- [ ] A technician asking their agent for a week ~5+ weeks out gets the "isn't published
      yet" wording (can fold into Ben's owed device pass)

---
*Pause after Phase 4 for the device checks.*

## Final review gate (2026-07-22, 8-angle /code-review on the full diff)

26 candidates across 8 finder angles → deduped and fixed in one round (all gates green
after, 602/602):
- **Fixed (correctness):** get_schedule-suite relative fixtures leaked into later
  fixed-December suites — deterministic collision from late November (afterAll cleanup +
  relDay hoisted to one module-scope copy); empty-string `from` regressed to invalid_range
  vs main/board parity (truthiness default restored + pinned by test); board.js conflated
  "fully beyond horizon" with "trimmed-but-empty" (payloads now carry structured
  `horizonEnd`; the client branches on data, never the sentence); past-dated parked visits
  vanished from the tray entirely while their jobs stayed anti-joined away (bucket now
  unbounded into the past + `overdue` flag, rendered on the tray row); get_schedule's
  description claimed days:[] = free, contradicting the clamp (sentence added — restarts
  already required this rollout, so the description change is free).
- **Fixed (consolidation/efficiency):** horizon policy single-homed in
  `schedule/policy.ts` (`horizonDaysFor` + `clampToTechnicianHorizon` — chat and board can
  no longer drift on boundary or wording); unscheduled-jobs projection single-homed
  (`readUnscheduledJobs` serves board tray AND agent recall — parity by construction);
  `listUnassignedOpenJobs` became a projection of the with-customer lister (ONE anti-join
  body); jobs query trimmed to named columns (no more L3 `attributes` JSONB on the wire);
  bucket + recall reads parallelized (depth 2, not 3); board.js stores only the pill count
  (a cached payload invited stale-tray rendering).
- **Judged not-a-bug:** the inclusive horizon boundary (today+N is the last visible day —
  "N weeks ahead" counts correctly; convention documented in policy.ts); deploy-order
  hazard (already sequenced migration-first in this phase, PR #58 lesson); `proposed`
  unassigned rows invisible to both bucket halves (latent — no production writer; recorded
  limitation in the lister comment for Plan-3c/4b).
- **Surfaced, not acted on (nits):** fetchBucket refires on every pager/tab navigation
  (endpoint is now cheap; revisit if tenants grow); no LIMIT on bucket rows (tenant job
  counts small; revisit with a count+page if a firm backlogs hundreds); relDate helpers
  still duplicated across the three test FILES (house style keeps test files
  self-contained; the intra-file duplicate was removed).
