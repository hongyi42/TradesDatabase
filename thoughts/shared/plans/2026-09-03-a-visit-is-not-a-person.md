---
date: 2026-09-03
task: "Build 8 — a crew visit counts as ONE visit, and the planner is told two crew gaps are one question"
research: thoughts/shared/research/2026-09-02-a-visit-is-not-a-person.md
status: superseded
supersedes: docs/engineering-memory.md §8 (two factual claims + the framing — see Decisions)
---

> **SUPERSEDED 2026-09-03 (user).** This plan patched the reading layer — counts, a `with:` line,
> confirmations — of a schema the user then decided to replace: *"we designed the scheduling features
> badly… we're really just trying to have the users fit to our reality of scheduling."* The remodel is
> rungs 8–11 in `docs/engineering-memory.md` §6a. The research this plan cites stands. Nothing here
> was implemented.

## Overview

One visit assigned two or more technicians is two `assignments` rows and nothing links them
(user ruling 2026-09-01). This plan makes a crew visit **count as one**, tells the planner that two
gaps on one crew visit are **one question**, and makes the booking and move verbs **say** who else is
on the slot. It changes no table and adds no migration: a visit is derived — the same job, the same
exact window, confirmed rows only — and the crew rides in the gap's existing `context` JSONB.

## Decisions

- **The gap stays per-person; the planner is told they are one visit** (user, 2026-09-03). Options
  were (a) two gaps, planner informed, or (b) one gap per visit. Chose (a): no schema change, every
  mechanism intact, and reversible — (b) can be chosen later on evaluation evidence, whereas
  unwinding a subject-scheme change that history rows were written under cannot. Accepted cost: a
  crew visit still contributes two rows to `mv_gap_outcomes` / `mv_whiplash`, and the planner *can*
  still text both people — it is informed, not prevented.
- **`get_team_schedule` returns two stops and a count of one** (user, 2026-09-03). Counts are
  visits, stops are people going, and the `countsNote` says so. Collapsing the stop was rejected
  because `assignmentId` is the handle `move_visit` / `unschedule_visit` / `set_visit_locks` take —
  pluralising it drags in "move the whole crew", which drags in a visit identity.
- **Booking and move both say it** (user, 2026-09-03). Read-only additions, no schema, no new verb.
- **A visit is `job_id` + exact `starts_at` + `ends_at`, confirmed rows only.** Not derived from
  `v_schedule.local_day` (it applies `at time zone` to a naive-local stamp — a recorded trap), and
  not from a new column. Narrower than the ambiguity `listIdenticalUnplacedVisits` (`assignments.ts:715`)
  already ruled on: that was same *customer* + window (two trades, same week); this is the same
  **job**, which is a much stronger signal of one trip.
- **The sweep derives the crew from `candidates`, never a per-gap query** — this loop runs every
  five minutes for every firm; an N+1 here would be its most expensive line. Two crew rows share
  `ends_at` exactly, so both are already in `candidates` whenever either is.
- **`buildGapView` reads `crewWith` out of `n.context` — no new parameter.** Its signature has ~60
  positional call sites across tests and the eval renderer; adding an argument buys nothing since
  the function already holds the context.
- **`unschedule_visit` is deliberately NOT covered.** Same hazard as move, but `unscheduleVisit`
  returns a bare `Assignment` — surfacing crew means reshaping its return type and both call sites,
  out of proportion to this build. Recorded as a known remaining hole.
- **CORRECTIONS to `docs/engineering-memory.md` §8, carried from the research.** (1) `visits` is NOT
  dormant — `recordFieldNote:267` writes one per field note from all three inbound routes, and
  `listVisitTimesForJobs` feeds the detector's own freshness test. (2) Reschedule is cancel+insert
  with a NEW id, so an assignment id can never name a visit across a move. (3) §8 says build 7
  decides the subject scope; it did not, and this plan decides it — **per-assignment, kept**.

## Plain-language walkthrough

**Phase 1 — the count.** Today, asking "how many visits tomorrow?" about a two-person visit answers
*two*, because the server counts booking rows. This phase counts distinct visits instead, keeps
listing both people as separate stops (that is who is going, and each stop carries the id the move
verb needs), and corrects the four places that *tell* an agent a row is a visit: the note on the
result, the `query_spine` view catalog, that tool's own worked SQL example, and the box doctrine. You would notice
it working by booking two people onto one slot and seeing `counts.total: 1` next to two stops.

```
   BEFORE                                  AFTER
   stops: [Ben, Joy]   counts.total: 2     stops: [Ben, Joy]   counts.total: 1
                                ▲                                        ▲
                        two booking rows                        one job + one window
```

**Phase 2 — the gap knows its crew.** The detector that notices "a visit ended and nobody reported"
opens one gap per person, so a crew visit makes two. Worse, because both sit on one job, the planner
is currently handed a warning saying *"make sure it answers THIS question, not the other one"* — and
it is one question. This phase stamps the crew into each gap's record, prints a `with:` line naming
them, and stops that warning firing when the only other gap on the job is a crew-mate's. It still
fires for a genuinely different question (a cost gap on the same job). You would notice it in the
planner's gap block: `with: Joy — the same visit, not a second one.`

**Phase 3 — the verbs say it.** Booking a second person onto a slot, or moving one row of a crew,
currently says nothing about anybody else. Moving half a crew silently strands the other person and
nothing anywhere notices. This phase adds one read — who else is confirmed on this job at this exact
window — and surfaces it on both confirmations. You would notice it by booking Joy onto Ben's slot
and getting back `alsoOnThisVisit: [Ben Shelton]`.

## Secrets & env preflight

- **Phase 1:** none
- **Phase 2:** none
- **Phase 3:** none

All three phases run entirely against the local Supabase stack (`.env.test`, `npx supabase start`).

---

## Phase 1: The count is visits, not rows

### What this phase does
Collapses `get_team_schedule`'s three counters to distinct visits, adds a person-trip counter
beside them, and corrects the four prose surfaces that assert a row is a visit.

### Changes required

**`src/mcp/server.ts`**
- `:4424-4426` — replace `dayCount` with a distinct-visit count. A stop already carries `jobId`,
  `startTime`, `endTime`:
  ```ts
  // A VISIT IS A JOB PLUS AN EXACT WINDOW (build 8). Two technicians on one
  // visit are two assignment rows and therefore two STOPS — both are listed
  // (that is who is going, and each stop carries the assignmentId the move
  // verbs take), but they are ONE visit and must count once.
  const dayCount = (stops: unknown[]) =>
    new Set(
      stops
        .filter((s) => (s as { timeTbd?: boolean }).timeTbd !== true)
        .map((s) => {
          const st = s as { jobId: string; startTime: string | null; endTime: string | null };
          return `${st.jobId}|${st.startTime}|${st.endTime}`;
        }),
    ).size;
  ```
- `:4431-4434` — the dedupe must happen over `allUnplaced` **before** the map: `tbdRanges` projects
  to `{lo, hi}` and drops `job_id`, so there is nothing to key on afterwards. `allUnplaced` is
  `UnplacedStripRow = Assignment & {…}` (`assignments.ts:661-668`), so `job_id` is present.
- `:4454-4457` — `timeTbdListed` counts distinct `jobId|earliestDate|latestDate`, not stops.
- `:4450-4458` — **add `people` beside `total`**: the per-person trip count (today's `total`,
  computed the old way). Without it the collapse creates a regression — `countsNote` forbids
  counting the stop rows, and after the collapse person-trips live *only* in the stop rows, so
  "who is slammed this week" (graded by `src/eval/corpus.ts:731-740`, S08) would have no server-side
  number and force exactly the hand-tally the counter exists to prevent.
- `:4468-4477` — extend `countsNote`: `'A visit with two people on it is ONE visit and TWO stops. '
  + 'counts.total/byDay are VISITS; counts.people is person-trips — use that one for how-busy-is-'
  + 'somebody questions. Still never count the stop rows yourself.'`
- `:765-766` — correct the `SPINE_VIEW_CATALOG` line for `v_schedule`. It currently claims
  *"count(\*) here is real bookings"*. Replace with wording that says a row is a **person on a
  visit**, and that counting visits means `count(distinct (job_id, starts_at))`. Keep the rest of
  the sentence verbatim. This string is shared with `spine_read` (`:1840`), so the fix reaches the
  planner too.
- `:1348-1349` — the **fourth** prose surface, and the most directly instructional: `query_spine`'s
  `sql` parameter description carries the worked example
  `select technician_name, count(*) as visits from v_schedule …`, which literally labels a
  per-person row count "visits". Relabel it (`count(*) as trips`) or switch it to a
  `count(distinct …)` visit example.

**`Box_Setup_Stuff/bootstrap-box.sh`**
- Add clause 9 to the `## Dates and times — never guess, always resolve` heredoc, immediately before
  the `EOF` at `:897` (after clause 8, which is the sibling counting rule):
  ```
  9. A v_schedule row is a PERSON ON A VISIT, not a visit. Two technicians sent to one job at one
     time are two rows and ONE visit, so `count(*)` counts people-trips; count visits with
     `count(distinct (job_id, starts_at))`. get_team_schedule already does this for you — its
     `counts` are visits and its `stops` are who is going; never reconcile the two by hand.
  ```
- Section name is unchanged, so `EXPECTED_SECTIONS` (`src/eval/doctrine.ts:28-47`) needs no edit and
  `doctrineFingerprint` has no pinned literal to break.
- **Not deployed by this change.** The fleet gets it at the harness rebuild's rollout, which must
  md5 the six bootstrap copies first (memory: `bootstrap-copy-drift-trap`). `docs/nemoclaw-tech-agent.md`
  needs no edit — it narrates the agent stack's architecture, not this clause.

### Automated verification
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] New test in `src/mcp/server.test.ts`, inside `describe('scheduling tools …')` (`:3750`): book
      TWO people onto one job at one window via the real `book_visit` (second call uses `jobId`),
      then `get_team_schedule` for that day asserts `counts.total === 1`, `counts.people === 2`,
      `counts.byDay[day] === 1`, and `days[0].stops.length === 2` with two distinct `assignmentId`s.
      **Mutation check:** revert `dayCount` and confirm the test fails.
      **Setup constraints — both are load-bearing:** the file truncates `technicians` and seeds only
      `mgr-test` (manager) and `tech-mcp`, with `technicianSeats: 3` consumed by the seat-cap tests
      at `:905-1211` — so use **`mgr-test` as the second crew member** rather than adding a seat
      (`resolveTechnician` gates on state, never tier — `booking.ts:113-120`). And pick a window
      **outside `2026-12-20 … 2026-12-24`**: the existing exact-count assertions at `:4009-4011`
      run on the same tenant. (Those assertions do not break from the collapse itself — each of
      their bookings uses `customerId`, minting a distinct job.)
- [ ] New test: two crew rows booked `timeTbd` on one range assert `counts.timeTbdListed === 1`
      and `counts.windowCoverByDay[day] === 1`.
- [ ] `npx vitest run src/eval/doctrine.test.ts` passes (section list + fingerprint unaffected)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack running (`npx supabase start`); no MCP needed — the test
  harness drives the real tool through `dispatchForIdentity`.
- [ ] Covered by the automated tests above: they call the real verb and read the rows back through
      `pg.query`, which is the cross-channel confirmation.

### Manual verification
- [ ] None — every check is mechanical.

---

## Phase 2: The gap knows its crew

### What this phase does
Stamps the crew into each visit gap's `context`, renders it in the planner's gap block, and stops
the shared-evidence warning firing between crew-mates — while keeping it for a genuinely different
question on the same job.

### Changes required

**`src/jobs/watchers.ts`**
- Inside `if (overdueSpec && fresh.length > 0)` (`:584`), before the `for (const g of fresh)` loop
  (`:593`), build the crew index from `candidates` — already in hand, no new query:
  ```ts
  // THE CREW (build 8). A visit is a job plus an exact window; two people on
  // one are two rows and nothing links them, so it is derived. Built from
  // `candidates` — the tick already holds it, and a per-gap read here would be
  // an N+1 in a loop that runs every five minutes for every firm.
  const crewByVisit = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const key = `${c.job_id}|${c.starts_at}|${c.ends_at}`;
    crewByVisit.set(key, [...(crewByVisit.get(key) ?? []), c]);
  }
  ```
- Inside the loop, before `createObs`:
  ```ts
  // Distinct rows are distinct people: no_confirmed_overlap forbids one
  // technician twice in one window. A person-less sibling names nobody, so it
  // contributes no name.
  const crewWith = (crewByVisit.get(`${g.job_id}|${g.starts_at}|${g.ends_at}`) ?? [])
    .filter((c) => c.id !== g.id && !!c.technician_id)
    .map((c) => techById.get(c.technician_id as string))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({ ref: t.ref, name: t.display_name }));
  ```
- Add `...(crewWith.length > 0 ? { crewWith } : {})` to the `context` object (`:600-612`).
  `techById` already covers managers and inactive rows — `listTeam` (`technicians.ts:145`) filters
  by neither tier nor state, which is what makes the pilot's Ben+Joy specimen resolve.
- No change needed for the send path: `createFromObservation` copies `context: row.context`
  verbatim (`planner.ts:3117`), so `crewWith` survives into the nudge.

**`src/teamLead/planner.ts`**
- Add a fail-closed reader beside `ctxStr`:
  ```ts
  // context.crewWith — who ELSE was on this visit (build 8). Anything that is
  // not an array of objects with a string `name` yields no names, which renders
  // as no line: a malformed context must never put a name in front of the
  // planner that the record did not write.
  function crewNames(n: Nudge): string[] { … }
  ```
- In `buildGapView`, immediately after the `person:` line (`:1343`), add:
  ```ts
  ...(crewNames(n).length > 0
    ? [`  with: ${crewNames(n).join(', ')} — the same visit, not a second one. ` +
       `A note from any of them is a report on this visit.`]
    : []),
  ```
  **The copy is deliberately narrower than "either person's report fills this gap."** That is true
  of the evidence block (`hasActivitySince` is job-scoped, `watchers.ts:465`) but **false of the
  attribution stamp**: `attributeAnswerToGap` keys on `(technician_id, jobId)` (`nudges.ts:622`), so
  a crew-mate's note never sets *this* gap's `answered_by_capture_id` and the `answered:` line will
  still read as nothing-attributed. Promising more than that would have the block contradict itself
  four lines down.
- At the call site (`:3879-3911`), narrow `sharesJob` so crew-mates stop tripping it. Add beside
  `gapsPerJob`:
  ```ts
  // Gaps that are the SAME VISIT are the same question, so they must not trip
  // the shared-evidence warning — which exists to say these are DIFFERENT
  // questions. Keyed off the context the detector stamps; a cost gap has no
  // startsAtLocal and so is never a crew-mate.
  const visitKeyOf = (n: Nudge): string | null => {
    const j = ctxStr(n, 'jobId'); const s = ctxStr(n, 'startsAtLocal'); const e = ctxStr(n, 'endsAtLocal');
    return j && s && e ? `${j}|${s}|${e}` : null;
  };
  const gapsPerVisit = new Map<string, number>();
  for (const n of open) { const v = visitKeyOf(n); if (v) gapsPerVisit.set(v, (gapsPerVisit.get(v) ?? 0) + 1); }
  ```
  and replace the 4th argument at `:3909`:
  ```ts
  const sameVisit = (() => { const v = visitKeyOf(n); return v ? (gapsPerVisit.get(v) ?? 1) - 1 : 0; })();
  const otherOnJob = (j ? (gapsPerJob.get(j) ?? 1) - 1 : 0) - sameVisit;
  … buildGapView(n, nowMs, evidence, otherOnJob > 0, …)
  ```
  The warning's own text (`:1506-1513`) is **unchanged** — it just fires less.
- **Known graceful degradation, state it in the code comment:** gaps minted before this build carry
  no `crewWith`, so they get the narrowing (which keys off `startsAtLocal`, stamped since long
  before) but no `with:` line. Less information, nothing false.

**`src/teamLead/planner.test.ts` — three existing tests break, and the fixture is the reason.**
The shared `nudge()` fixture stamps `startsAtLocal`/`endsAtLocal` on **every** row it builds
(`:53-61`), including ones overridden to `kind: 'job_cost_gap'`. Production cost gaps carry only
`endsAtLocal` (`watchers.ts:676-678`), so the fixture is **unfaithful to what the detector writes** —
and under `visitKeyOf` those rows collapse to one visit key, making `otherOnJob` 0 and silencing the
warning the tests assert. Fix the fixtures, not the narrowing:
- `:353-363` (money-is-shared warning) and `:1136-1147` (more-than-one-open-gap) — drop
  `startsAtLocal`/`endsAtLocal` from the `job_cost_gap` override so it matches `watchers.ts`.
- `:2404-2436` (the anti-drift whole-string lock) — two default-context nudges whose expected views
  are built with the 4th argument hardcoded `true` at `:2424`, compared against `runPlanner`'s
  output, which now computes `false`. Give `n2` a distinct window, or recompute the argument.
- `:3248` is safe — it calls `buildGapView` directly with an explicit `true`.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] New test in `src/jobs/watchers.test.ts`: two confirmed overdue rows on one job at one window →
      both observations carry `context.crewWith` naming the *other* person only.
      **Mutation check:** delete the `.filter((c) => c.id !== g.id …)` clause and confirm the test
      fails (a gap must not list its own person).
- [ ] New test: a third row on the same job at a **different** window gets no `crewWith`.
- [ ] New test in `src/teamLead/planner.test.ts`: `buildGapView` on a nudge whose context has
      `crewWith` renders `with: Joy`; one without renders no `with:` line; a `crewWith` of
      `[{ref:'x'}]` (no name) renders none.
- [ ] New test driving the `runPlanner` call site (NOT `buildGapView` in isolation — the build-7
      lesson that isolated-render tests miss the pipeline): two crew gaps on one job → neither block
      contains `SHARED between them`; add a `job_cost_gap` on the same job → all three blocks do.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [ ] Fresh-context subagent runs the real `runWatchers` in `live` mode against two seeded crew
      assignments on the local stack, then reads both `observations` rows back with `psql`/`pg` and
      reports the two `context.crewWith` values as evidence — not "looks right".

### Manual verification
- [ ] Read the rendered gap block for a crew gap and judge that `with:` + the absent warning read as
      one coherent statement rather than two half-statements.

---
*Pause after this phase — its Manual verification list is non-empty.*

## Phase 3: Booking and moving say who else is there

### What this phase does
Adds one crew read and surfaces it on both confirmations, closing the live hole where moving half a
crew silently strands the other person.

### Changes required

**`src/db/assignments.ts`** — new function, after `listAssignmentsForJob` (`:509-518`):
```ts
export interface CrewMate { assignmentId: string; ref: string; displayName: string }
// WHO ELSE IS ON THIS VISIT (build 8) — the derivation stated once for the
// booking verbs. Confirmed rows only: a proposed or cancelled row is not
// somebody who is going. Same key the sweep uses (watchers.ts).
export async function listCrewOnVisit(
  tenantId: string, jobId: string, startsAt: string, endsAt: string,
): Promise<CrewMate[]>
```
Select `'id, technician_id, technicians(id,ref,display_name,tenant_id)'`, filtered on
`tenant_id`, `job_id`, `status='confirmed'`, `starts_at`, `ends_at`; drop rows whose embedded
technician is null or whose `technicians.tenant_id !== tenantId` (the id-only-FK re-check, the
`boardRead` pattern used throughout this file). The select/embed shape matches
`IDENTICAL_UNASSIGNED_SELECT` (`:621`) and `.eq('starts_at', …)` on naive-local ISOs is the existing
idiom (`:637-638`). No `src/db/index.ts` edit needed — `:17` already re-exports this module
wholesale.

**`src/schedule/booking.ts`**
- `ResolvedBooking` gains `alsoOnThisVisit: CrewMate[]`. In `resolveBooking`, in the **placed** arm
  after `startISO`/`endISO` are computed (`:396-397`) and only when `input.jobId` is set (a
  `customerId` booking mints a fresh job, which by construction has no siblings):
  `const alsoOnThisVisit = input.jobId ? await listCrewOnVisit(tenantId, input.jobId, startISO, endISO) : [];`
  The unplaced arm (which returns early at `:374-386`) returns `[]`.
- `BookVisitResult` gains `alsoOnThisVisit: CrewMate[]` from `r`.
- `BookVisitPreview` gains it too — **and it must be added by hand**: `previewBookVisit`
  (`:477-501`) builds an explicit object literal field by field and never spreads `r`, so a required
  field does not "come free" and `tsc` fails until the line is written. Same for `previewMoveVisit`
  (`:784-802`). *Side effect to record:* the whole preview is persisted into
  `review_items.detail.preview` (`server.ts:4670`), so the crew list rides into the staged item and
  the echoed confirmation. Harmless, and worth knowing it is stored.
- `ResolvedMove` gains `leftBehind: CrewMate[]`. In `resolveMove`, after `old` is validated
  (`:668-672`) and only when `isPlaced(old)` (already imported, used at `:700`/`:724`):
  `(await listCrewOnVisit(tenantId, old.job_id, old.starts_at, old.ends_at)).filter((c) => c.assignmentId !== old.id)`
- `MoveVisitResult` and `MoveVisitPreview` gain `leftBehind`, passed through.

**Accepted cost, stated because it contradicts Phase 2's own reasoning.** Putting the read in the
shared front-halves means every batch caller pays it: `freezeCommit.ts:72,109,116` (two per
placement), `resolveCommit.ts:162,201,217` (up to three per move), `undoRun.ts:356`,
`boardApi.ts:459,749`, and the MCP one-shot move twice (`server.ts:4820` preview, `:4840` commit).
Phase 2 refuses an N+1 in the sweep and this accepts one here, and the distinction is real rather
than convenient: the sweep runs unattended every five minutes for every firm forever, while a freeze
is a manager-initiated one-off, and this is a point read on `idx_assignments_job`. If a freeze over a
large plan measures badly, the fallback is to lift the read into the two MCP handlers that surface
it and give up the preview's copy.

**`src/mcp/server.ts`** — four return sites, two per verb. **Two of them have no `note` to extend**:
- `book_visit` one-shot (`:4573-4630`): spread
  `...(booked.alsoOnThisVisit.length ? { alsoOnThisVisit: booked.alsoOnThisVisit } : {})` and extend
  the existing `note` with *"alsoOnThisVisit lists who is ALREADY booked on this exact slot — the
  same visit, not a clash. Say who else is going."*
- `book_visit` confirm-commit (`:4780-4803`): same spread, but this return has **no `note` key at
  all** — add a fresh unconditional one carrying the same sentence.
- `move_visit` one-shot (`:4852-4870`): spread
  `...(moved.leftBehind.length ? { leftBehind: moved.leftBehind } : {})` and extend the existing
  `note`.
- `move_visit` confirm-commit (`:4975-4993`): same spread. Its only `note` sits **inside**
  `...(moved.promiseBroken ? { note: … } : {})` (`:4985-4992`), so attaching the crew sentence there
  would surface it only on promise-breaking moves — the wrong half. Add a separate unconditional key
  (e.g. `crewNote`) and **do not overwrite** the promise-break note.
- Crew sentence for both move sites: *"leftBehind is who is STILL at the old day and time — moving
  one person does not move the others. Tell the manager, and move them too if that is what was
  meant."*

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] New test in `src/mcp/server.test.ts` (`describe('scheduling tools …')`): book Ben, then book
      Joy with the same `jobId`/window → the second result's `alsoOnThisVisit` names Ben with his
      ref and assignment id; the first result has no such key.
- [ ] Same test continues: `move_visit` Ben to another day → the result's `leftBehind` names Joy;
      `pg.query` read-back confirms Joy's row still holds the old `starts_at`. **Mutation check:**
      drop the `.filter((c) => c.assignmentId !== old.id)` and confirm the test fails (a move must
      not list itself as left behind).
- [ ] New test: booking a single person on a fresh slot returns `alsoOnThisVisit` absent/empty.
      (Dropped from the plan: "a `timeTbd` booking never calls the read" is **unobservable** —
      neither `server.test.ts` nor `booking.test.ts` uses module spies, and an absent
      `alsoOnThisVisit` is equally true whether the read ran and found nothing or never ran. Assert
      it only if a `vi.mock` on `../db/assignments.js` is added.)
- [ ] New unit test for `listCrewOnVisit`: a `cancelled` sibling and a sibling at a different window
      are both excluded; a cross-tenant embed is dropped.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [ ] Fresh-context subagent drives the real `book_visit` twice and `move_visit` once through
      `dispatchForIdentity` as a manager, then reads `assignments` back with `pg` and reports both
      rows' `starts_at` plus the two tool payloads as evidence.

### Manual verification
- [ ] Judge that the two notes read as information, not as a warning about a clash — a crew booking
      is normal, and copy that sounds like an error would teach the agent to undo it.

---
*Pause after this phase — its Manual verification list is non-empty.*

## Out of scope, recorded

- **`unschedule_visit` says nothing about the crew.** Same hazard as move; deferred because its
  return type is a bare `Assignment` (`booking.ts:924`).
- **Gap metrics still count a crew visit twice** (`mv_gap_outcomes`, `mv_whiplash` are per-nudge) —
  the accepted cost of keeping the gap per-person. Evaluation-phase work.
- **Nothing deploys.** Migrations: none. The box doctrine clause reaches the fleet only at the
  harness rebuild's rollout, behind the six-copy md5 check.
