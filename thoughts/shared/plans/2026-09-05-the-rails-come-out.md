---
date: 2026-09-05
task: "Rung 9, part A — delete the promise ladder and the stored window; no schema rail restricts the agent"
research: thoughts/shared/research/2026-09-05-the-visit-is-one-object.md
status: complete
supersedes: nothing
---

**`supersedes: nothing`.** First half of rung 9, split on scope (user, 2026-09-05). Part B — `DROP
visits CASCADE` + `RENAME assignments → visits`, multi-technician, read-promises-from-L1 doctrine —
gets its own plan. `2026-09-03-a-visit-is-not-a-person.md` stays superseded.

## Overview

Delete every schema rail that restricts what the manager's agent may do with the schedule: the
promise ladder (`promise_level`, `promised_day`, `set_promise`) and the stored window
(`earliest_date`, `latest_date`, `assignment_placed_or_windowed`). After this a visit **has a time or
it does not**, and nothing in the database encodes what a customer was told.

Demolition first, rename second — the order that made rung 8 work. Renaming first would rename ~600
references about to be deleted.

## Decisions

- **Split rung 9 in two** *(user)* — one plan blew the 5-phase/300-line review budget. Rails now,
  object next; also shrinks Part B's rename surface by ~600 refs.
- **Both rails die** *(user ruling)* — *"The promise level of a job shouldn't restrict the agent, nor
  should the window concept, especially because the lifecycle of a job can be shortened and extended
  depending on how the humans act."*
- **`book_visit` books with no time at all** *(user)* — `timeTbd`/`earliestDate`/`latestDate` go;
  `date`/`startTime`/`endTime` become optional. **Rationale recorded verbatim because it governs Part
  B:** *"If a manager wants to book something sometime next week, they can ask the seat agent, who
  might ask the planner for suggestions also because the planner has the firm's full workflow
  memory/context… scheduling doesn't have to run with our imaginations… we want to encourage (or
  perhaps even train our users through the seat agents) behaviors that utilize AI."* Precedent the
  user named: the planner's gap-chasing already trains users this way.
- **Confirmations: keep two-step on `unschedule_visit` only, re-gated on PLACEMENT** *(user, after
  the reviewer found the ladder gates three things, not one)* — `bookingRequiresConfirmation`
  ([booking.ts:217](src/schedule/booking.ts#L217)) gates `book_visit` **and** `unschedule_visit`, not
  just `move_visit`'s `promiseBroken`. Chosen: book and move go one-shot; unschedule keeps two-step
  when the visit **is placed** (a customer is expecting it). Matches
  `agent-confirmation-ux-tone`: confirm only the irreversible/externally-visible.
  `pending_booking` becomes unreachable and is deleted; `pending_visit_cancel` survives.
- **The unscheduled list orders by AGE, and `created_at` is NOT age** *(reviewer)* — every move/park/
  attach is cancel + insert with a new id, so `created_at` resets and a month-old visit jumps to the
  bottom the moment a technician is attached. Chosen: **carry the original `created_at` forward**
  through `rescheduleAssignment` and `attachUnplacedVisit`. (Rejected: deriving age from
  `schedule_events` lineage — a join on every tray read.)
- **`find_slots(earliestDate, latestDate)` SURVIVES** — a search range, not a commitment
  ([server.ts:1637-1641](src/mcp/server.ts#L1637)). Deleting it alongside the window is the mistake
  this plan exists to prevent; a grep guards it.
- **An untimed visit occupies NO day in `find_slots`, and can never be overdue** — decided here.
  `fit.ts:419` currently blocks a window's days and `boardRead.ts:373` marks a row overdue past
  `latest_date`. Both inputs are deleted; a visit with no time is on no day and has no deadline, so
  no replacement is needed. Stated so nobody reads the loss as a bug.
- **Migration is a column drop, not a row migration** — probed: row deletes are refused by the
  append-only triggers, column/table DDL is not.
- **Deploy CODE FIRST, then the column-drop migration** — running pilot code writes `promise_level`
  on every insert. Same exception rung 8's `20260905100000` documented. (The Phase-2 constraint drop
  is the exception's exception — see Phase 2.)

### Probe evidence (local stack, 2026-09-05, rolled back)

| Probe | Result |
|---|---|
| `DELETE FROM visits` / `FROM jobs` (L1-pinned) | ❌ `raw_captures is append-only` |
| `DROP TABLE assignments CASCADE` | ✅ `schedule_events` rows survive, id dangles |
| `DROP TABLE visits CASCADE` + `RENAME` | ✅ both succeed |
| all-NULL insert with the CHECK present | ❌ `23514 assignment_placed_or_windowed` |

`ON DELETE SET NULL` fires an `UPDATE`, which `BEFORE DELETE OR UPDATE` refuses; dropping a
constraint updates no rows. Only `v_schedule` and `v_cancelled_visits` depend on the four columns
(`pg_depend`-verified) — no indexes, no functions, no other views.

## Plain-language walkthrough

Today the database holds two things it shouldn't: a **promise** (what the customer was told) and a
**window** (a date range the visit must land in). Both go stale the moment a human changes their
mind, and both stop the agent doing what the manager just asked.

```
BEFORE                                   AFTER
  promise_level  none|day|time|time_only    (gone)
  promised_day   2026-09-10                 (gone)
  earliest_date  2026-09-08 ┐ either/or     (gone)
  latest_date    2026-09-12 ┘ CHECK         (gone)
  starts_at/ends_at  set OR null            starts_at/ends_at  set OR null

  book onto a promised job → 2 steps        book  → one shot
  move off the promised day → 2 steps       move  → one shot
  unschedule a promised visit → 2 steps     unschedule → 2 steps IF it is placed
```

**Phase 1** removes the promise ladder and re-gates the confirmations. Booking and moving become
one-shot; cancelling a *placed* visit still stops and asks, because a customer is expecting it. You'd
notice it working when `move_visit` stops returning `needs_confirmation` for a date change.

**Phase 2** removes the stored window. `book_visit` loses `timeTbd` and the date range; omitting the
time books an untimed visit. The manager's unscheduled tray becomes a flat oldest-first queue. This
phase carries a **small migration of its own** — dropping the either/or CHECK — because without it
the database rejects an untimed row and the phase cannot test itself.

**Phase 3** drops the four columns, rebuilds the two views, regenerates types, and strips the
doctrine — including the copies on the six sandbox seats and the Mini App the board runs. Deploys
**after** the code.

## Secrets & env preflight

- **Phase 1 / 2:** none
- **Phase 3:** none new. Box rollout uses the existing `ssh tradesbox` key (`already required`).

Local Supabase stack running for `npm test`; `.env.test` present, `testEnvGuard` pins localhost.

## Phase 1: The promise ladder comes out

### What this phase does
Deletes `promise_level`/`promised_day` from every code path and the `set_promise` tool, and re-gates
the three confirmation paths it powered. Columns stay in the DB until Phase 3.

### Changes required

| File | Change |
|---|---|
| `src/schedule/booking.ts` | Delete `isPromiseLevel` (:70), `carriesPromisedDay` (:78), `carriesPromisedTime` (:88), `bookingRequiresConfirmation` (:217), `promiseBroken` (:722-725), both `requiresConfirmation` sites (:776, :794-795), `promisedDay` stamping (:565-574), `promiseLevel` from the input types (:194, :330, :436, :441). **`previewUnscheduleVisit` (:913) re-gates to `isPlaced(old)`.** `visitDay` (:64-68) drops its `promised_day` arm and renders "no time set" for an untimed row |
| `src/db/assignments.ts` | Delete `PromiseLevel` (:9), `updateAssignmentPromise` (:263-292); remove promise fields from `CreateAssignmentInput` (:29) and the insert (:66-90) |
| `src/mcp/server.ts` | Delete `set_promise` schema (:1541) + dispatch (:6322); remove `'set_promise'` from `BOARD_LINK_TOOL_NAMES` (:1903); drop `promise_level, promised_day` from **both** view column lists in `SPINE_VIEW_CATALOG` (:737+); remove `promiseLevel` from `book_visit`/`move_visit` schemas + dispatch; rework the one-shot-vs-staged branch (:4420) to the new gate; delete the `pending_booking` staging (:4488-4535) |
| `src/db/reviewItems.ts` | Remove the `'pending_booking'` review kind (:20) — unreachable once booking is one-shot. **Keep `'pending_visit_cancel'`** |
| `web/board/board.js` | **Plain JS, invisible to typecheck/lint/test.** Delete promise badges (:126-135), `promiseText()` (:711-725), the "Scheduling promise" row + pencil (:811), the level picker (:1129-1135), the promise-break confirm copy (:1060-1071, :1104), and the `POST /board/api/promise` call (:1205-1208) |
| `src/telegram/boardApi.ts` | Delete the `/board/api/promise` route (:313, :526-548) and promise renders |
| `src/schedule/boardRead.ts` · `src/db/context.ts` · `src/synthesis/grounding.ts` · `src/schedule/fit.ts` | Remove promise reads/renders. `fit.ts:475-476` loses its `promise_level` displacement tiebreak — order by start time instead |
| Evals / scripts | `src/eval/worldSpec.ts`, `corpus.ts`, `toolCases.ts`; `scripts/seed.mjs`, `scripts/spine-eval/world.mjs`, `verify-world.mjs`, `scripts/backfill-schedule.mjs` |
| Tests | `src/mcp/server.test.ts`, `booking.test.ts`, `boardApi.test.ts`, `scheduling.test.ts`, `fit.db.test.ts`, `worldSpec.test.ts`, **`boardNotify.test.ts` (:143-144)**, **`context.test.ts` (:88-89, :131-133)**, **`watchers.test.ts` (:49-54)** |

**Do not delete the confirmation tests — invert them.** A date-changing `move_visit` and a
`book_visit` onto a promised job must now return one-shot success; unscheduling a **placed** visit
must still return `needs_confirmation`. Those three assertions lock the behaviour change in.

**Tool-count pins (reviewer correction — the obvious edit is wrong):** `set_promise` is in
`ADMIN_TOOLS`, so the technician pin `toHaveLength(17)` at :189 and :2330 is **unchanged**. Change
`expect(mgrTools).toHaveLength(42)` → `41` at **:2050 and :2453**, and :2453's comment
`// base minus get_schedule + 26 admin` → `25 admin`.

### Automated verification
- [ ] `npm run typecheck` — the real gate: deleting `PromiseLevel` makes every caller a compile error
- [ ] `npm run lint` · `npm test` pass
- [ ] Inverted tests: `move_visit` date change → `status:'ok'`; `book_visit` → `status:'ok'`;
      `unschedule_visit` on a **placed** visit → `needs_confirmation`
- [ ] `grep -rIn -e promise_level -e promiseLevel -e PromiseLevel -e promised_day -e promisedDay -e set_promise src scripts web Box_Setup_Stuff docs | grep -v database.types.ts | grep -v supabase/migrations` returns only comments naming the removal *(case-sensitive `PromiseLevel` and the `web/` scope both matter — the first draft's grep missed them)*
- [ ] Manager tool pin is 41; technician pin still 17

### Live verification (agent-executable)
- Prerequisites: none — no live surface changes until Phase 3
- [ ] none

### Manual verification
- [ ] none
---
*Continue to Phase 2 once automated checks pass.*

## Phase 2: The stored window comes out

### What this phase does
Removes `earliest_date`/`latest_date` from every code path and the window arguments from
`book_visit`. **Carries its own migration** dropping `assignment_placed_or_windowed`: without that,
the database rejects the all-NULL row this phase creates, and the phase cannot test itself.

### Changes required

| File | Change |
|---|---|
| `supabase/migrations/20260906110000_drop_placed_or_windowed.sql` | `alter table assignments drop constraint if exists assignment_placed_or_windowed;` — **safe to apply BEFORE the code deploy** (running code only writes shapes the constraint already allowed), unlike Phase 3's column drops |
| `src/db/assignments.ts` | **Delete the XOR guard in `createAssignment` (:51-64)** — with the range gone, `placed === windowed === false` for an untimed row and it throws before reaching the DB. Remove window fields from `CreateAssignmentInput`/insert (:73). `listUnplacedAssignedForRange` (:606) / `listUnplacedForRange` (:631) → drop the range filters and `.order('earliest_date')`, keep `starts_at IS NULL`, order `created_at` ascending; rename without `ForRange`. `listIdenticalUnplacedVisits` (:656) → job+customer duplicate test. **`listUpcomingAssignmentsForCustomer` (:527-548)** reads `latest_date` inside a PostgREST template string — no compile error, a runtime 400 on `get_customer_context`/`brief_customer`; rewrite the `.or(...)` and decide sort for untimed rows |
| `src/schedule/booking.ts` | Delete the windowed-booking branch and resolve guard; **`attachUnplacedVisit` (:960-1085)** — `AttachUnplacedPreview.earliestDate/latestDate` are non-nullable (:1002-1004), `old.earliest_date as string` (:1017-1018, :1041-1042); the `notBeforeDate` guard (:985) must compare the **new** time to today, not the old window. Fix the required-field guard (:389) to `startTime ⇒ endTime` |
| `src/mcp/server.ts` | `book_visit` schema: delete `timeTbd` (:1047), `earliestDate` (:1048), `latestDate` (:1049). **Rewrite the guards at :4365-4374** — with `timeTbd` gone both become unconditional and refuse every timeless booking; `endTime` is a third optional-but-paired field the JSON schema does not enforce (`required: []` already). Descriptions :330-332, :979, :1025-1026, :1194. Drop `earliest_date, latest_date` from **both** `SPINE_VIEW_CATALOG` column lists. `:4869` unschedule result `?? cancelledRow.earliest_date`. **DO NOT TOUCH `find_slots` :1637-1641** |
| `src/schedule/boardRead.ts` | The tray at :241, :245, :362, :491 **plus :71-72, :299-303, :369-373, :407-408** — flat "Unscheduled" list ordered by `created_at`; `overdue` (:373) no longer applies to untimed rows |
| `src/schedule/fit.ts` | :381 `listUnplacedAssignedForRange` caller; :419 window-day occupancy — an untimed visit occupies no day (decision above) |
| `web/board/board.js` | Range label (:189-191), `tbdCard`/`renderDay` (:208-229, :306-309, :353), `v.timeTbd` when-text (:519-522, :549), `attachUnplaced` (:644-649), edit gate (:751-752), overdue gate (:834), range detail row (:778-779) |
| `src/telegram/boardApi.ts` · `boardNotify.ts` (:57) · `src/db/context.ts` (:37-39, :111, :123) · `src/synthesis/grounding.ts` (:66) | window reads/renders; boardNotify would print `?` for every untimed visit |
| `scripts/date-eval/{adjudicate-db,plan,run-direct}.mjs` | Raw SQL selecting/ordering by the columns (:64; :125,:131; :81,:87) — `.mjs`, so no gate catches these until the eval next runs |
| Tests | Phase 1's list plus `fit.db.test.ts` |

**Age ordering (reviewer finding):** `rescheduleAssignment` and `attachUnplacedVisit` must copy the
original `created_at` into the new row, or "oldest first" silently means "least recently touched".

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] New test: `book_visit({jobId, technicianRef})` with no date/time creates a row with
      `starts_at IS NULL` *(requires this phase's constraint-drop migration — that is why it is here)*
- [ ] New test: the unplaced list is oldest-first **and stays oldest-first after a reschedule**
- [ ] `grep -rIn -e earliest_date -e latest_date -e earliestDate -e latestDate -e timeTbd src scripts web Box_Setup_Stuff docs | grep -v database.types.ts | grep -v supabase/migrations | grep -v find_slots` returns only comments
- [ ] `grep -n "earliestDate" src/mcp/server.ts` still shows the `find_slots` params — regression guard

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP — deferred; the pilot keeps its columns until Phase 3

### Manual verification
- [ ] Open the board Mini App: the unscheduled tray reads as a flat oldest-first queue and no promise
      or date-range control remains. **`web/board/board.js` is invisible to every automated gate, so
      this is the only check that covers it**
---
*Manual list is non-empty — pause for the user before Phase 3.*

## Phase 3: The columns drop, the doctrine follows, the deploy

### What this phase does
Drops the four columns, the remaining CHECK and the enum; rebuilds both views; regenerates types;
strips the doctrine from the seats and the docs. **Code deploys first, then the migration.**

### Changes required

**`supabase/migrations/20260906120000_the_rails_come_out.sql`** — header states the deploy order and
why, following `20260905100000_drop_assignment_locks.sql`:
```sql
-- DEPLOY ORDER: **CODE FIRST, THEN THIS MIGRATION** — running pilot code writes promise_level on
-- every insert; applying this first breaks every booking until the deploy lands.
drop view if exists v_schedule;
drop view if exists v_cancelled_visits;
alter table assignments drop constraint if exists promised_day_when_promised;
alter table assignments drop column promise_level, drop column promised_day,
                        drop column earliest_date, drop column latest_date;
drop type if exists promise_level;
-- recreate BOTH views minus those columns, then RE-ASSERT grants (a dropped view loses them)
```
DROP+CREATE, never `CREATE OR REPLACE` — 42P16 bites on column removal (precedents
`20260806200000_v_schedule_local_weekday.sql:29`, `20260905100000:33`).

| File | Change |
|---|---|
| `src/db/database.types.ts` | `npx supabase gen types typescript --local`. **Never `npm run gen:types`** (it is `--linked` = the hosted pilot). Confirm `git diff --stat` is deletions-only |
| `src/db/schema.test.ts` (:133-141) | Asserts `earliest_date`/`latest_date` **exist** — Phase 3's own `db reset && npm test` gate fails without this. Delete those two assertions; keep the `starts_at`/`ends_at` nullability half |
| `Box_Setup_Stuff/bootstrap-box.sh` | Remove promise/window doctrine; keep a `grep -q` + `awk` strip half so already-wired boxes lose it on their next `wire` (rung 8's pattern). `bash -n` must pass |
| `docs/nemoclaw-tech-agent.md` (:134, :187, :195-196) | Documents `set_promise`, the four levels, the confirmation rule and the `timeTbd` booking shape. **The standing sync rule pairs this file with `Box_Setup_Stuff` in the same change** |
| `docs/getting-started-for-firms.md` · `docs/engineering-memory.md` | Remove promise/window teaching (rung 8 found the firm guide still taught the freeze after the code was gone). `getting-started-for-firms.md:253-272` is a whole section, *"Promises: the most important idea in the schedule"* |
| **ADDED after the Phase 1 review** — the ladder is taught in five more places the plan missed: `docs/onboarding.md` (:233-240 the four-level table, :622 the glossary row), `docs/customer-onboarding-runbook.md` (:249 the "manager moves a promised visit" row), `docs/doorman-runbook.md` (:383), `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` (:24 — the checklist a box operator runs to verify a seat), `Box_Setup_Stuff/doorman-architecture-memory.md` (:315, which also still pins *"Manager badge — 35"*). **Phase 1's completeness grep cannot pass until these land.** `docs/eval-baselines/*.jsonl` are historical run records — evidence, not documentation. Leave them. |

### Automated verification
- [ ] `npm run typecheck` · `lint` · `test` · `build` pass
- [ ] `npx supabase db reset` then `npm test` — proves the migration applies clean
- [ ] `bash -n Box_Setup_Stuff/bootstrap-box.sh`
- [ ] `git diff --stat src/db/database.types.ts` shows deletions only

**Deploy-order note (Phase 1 review finding 5).** Phase 1 deleted the `pending_booking` and
`pending_visit_move` staged kinds. Any such review_item still OPEN in the pilot when the code
deploys no longer hits the "confirm it via book_visit" refusal — `resolve_review` just closes it
and reports success. That outcome is *correct* (the staged intent is void; book_visit is one-shot
now and would not honour it), but the success wording is misleading. Tokens expire in 15 minutes,
so the window is small: check for open rows of those two kinds before deploying, and dismiss them.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (connected), Render MCP (connected)
- [ ] Deploy code to the web service; confirm `status: live` and the commit hash
- [ ] Apply the migration, then read back `information_schema.columns` for `assignments` — the four
      columns absent. **Evidence is the query result, not the tool's success line**
- [ ] `select … from v_schedule limit 1` and `from v_cancelled_visits limit 1` as `spine_reader` —
      both return and keep their grants
- [ ] Schema md5 over `information_schema.columns` matches local vs pilot
- [ ] One `lifecycle-heart` tick after the migration: `ok: true`, `tenantErrors: 0`
- [ ] **Deploy BOTH Render services, not just web** (review finding): `lifecycle-heart` imports the
      spine tool surface from `src/mcp/server.ts`, and the deployed `src/db/context.ts` /
      `src/schedule/boardRead.ts` SELECT all four columns — those reads 400 the moment the columns
      vanish, and the tick check above would only discover it afterwards
- [ ] **Roll the box doctrine to all six seats** (review finding — it is in this phase's prose and
      the preflight, but was in no checklist). Until `wire` runs, every AGENTS.md still teaches
      promise-gated staging and `timeTbd` booking against a server where `set_promise` is gone and
      book/move never stage — wrong in the direction that makes the agent ask for confirmations it
      will not get and pass arguments the schema rejects. md5 all seven `bootstrap-box.sh` copies
      against the repo first ([[bootstrap-copy-drift-trap]]), then **s2 first** (the canary seat)
      and confirm `grep -c "promiseLevel" AGENTS.md` → 0 before the fleet

### Manual verification
- [ ] Book a visit with no time from a manager seat; it appears in the unscheduled tray
- [ ] Move a visit to another date — goes through in one shot, no confirmation
- [ ] Unschedule a **placed** visit — still stops and asks
