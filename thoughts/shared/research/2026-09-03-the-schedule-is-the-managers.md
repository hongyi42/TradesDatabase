---
date: 2026-09-03
branch: feat/the-record-has-authors
commit: d481036
topic: "Rung 8 — the schedule is the manager's: the demolition footprint of the autonomous solver"
supersedes: nothing
---

**`supersedes:`** nothing. The decision to delete the solver is recorded in `docs/engineering-memory.md`
§6a/§8 (2026-09-03) and this document describes the ground it lands on. It overturns no earlier
document; it documents what the freeze plans (4b-3, 2026-07-30) built so that deleting it is exact.

## Summary

The **autonomous solver** is the part of the scheduling feature that plans the calendar by itself:
`run_freeze` places unscheduled work onto real slots using Google's Route Optimization API,
`run_resolve` re-arranges already-placed visits, `undo_run` reverses the last such run, and
`set_visit_locks` ("pinning") marks a visit the solver must not touch. The user ruled (2026-09-03)
that the manager makes the schedule and this whole ritual is deleted. This document maps exactly
what that deletion touches. The headline: the five solver modules are cleanly severable — **nothing
outside them depends on them, so nothing has to move** — but the demolition also reaches into four
files that *survive* (`booking.ts`, `server.ts`, `boardApi.ts`, `web/board/board.js`), one doctrine
clause that sits *outside* the freeze section, a database column shared with the promise ladder, and
two eval-world tenants that exist only to exercise the deleted verbs.

## Entry Points

| What | Where |
|---|---|
| The four tool schemas | `src/mcp/server.ts:1167` (`set_visit_locks`), `:1197` (`run_freeze`), `:1225` (`run_resolve`), `:1257` (`undo_run`) |
| The four dispatch cases | `src/mcp/server.ts:6533-6582`, `:6583-6783`, `:6784-7021`, `:7022-~7240` |
| The lock verb's implementation — **inside a surviving file** | `src/schedule/booking.ts:1175-1263` (`VisitLockSelector`, `SetVisitLocksResult`, `setVisitLocks`; writes `kind: 'lock_updated'` at `:1251`) |
| The solver | `src/schedule/freezeSolve.ts` (1,152 lines) |
| The board's two solver endpoints | `src/telegram/boardApi.ts:316-339` (`GET /board/api/freeze-proposal`), `:594-611` (`POST /board/api/lock`) |
| The doctrine section | `Box_Setup_Stuff/bootstrap-box.sh:966-1022` (§0h), refreshed per run by the delete-then-append at `:955-965` |
| The doctrine clause **outside** the section | `Box_Setup_Stuff/bootstrap-box.sh:704-708` — Confirmations clause 5, "Pinning (set_visit_locks) is one-shot and reversible…" |

## Key Files

**Deleted outright (the five, 2,325 lines + tests):**
- `src/schedule/freezeSolve.ts` (1,152) — `assembleFreezeInputs`, `buildFreezeModel`, `solveFreeze`, `partitionMovable`, `buildResolveModel`, `solveResolve`, `PINNED_SKIP_REASON` (`:163`), `normalizeWindows` (`:510`).
- `src/schedule/freezeProposal.ts` (292) — `projectOpenProposal` (`:185`), the board's read-only proposal projection.
- `src/schedule/freezeCommit.ts` (156) — `commitFreezePlan`; writes `kind: 'freeze_committed'` (`:138`), stamps `{ freezeRun }` into event detail (`:64`, `:141`).
- `src/schedule/resolveCommit.ts` (302) — `commitResolvePlan`; `kind: 'resolve_committed'` (`:277`).
- `src/schedule/undoRun.ts` (423) — `planUndo`, `commitUndoRun`; `kind: 'undo_committed'` (`:397`), `{ undoRun }` detail (`:301`, `:400`).
- Tests: `freezeSolve.test.ts`, `freezeProposal.test.ts`, `resolveCommit.test.ts`, `undoRun.test.ts`. (`fit.test.ts` / `fit.db.test.ts` each mention the solver exactly once, in a comment — they test `find_slots` and stay.)

**Freeze-only helpers that become dead with it:**
- `src/routes/roiClient.ts` (70) — `optimizeTours`, `MintRoiToken`, `RoiTransport`. Reads `GOOGLE_ROUTES_SA_KEY_JSON` (`:22`). Consumers: `freezeSolve.ts:54` and `server.ts:190` (types only, for the deps seam at `:259-261`). **Its `google-auth-library` import is the package's only use** (`package.json:53`).
- `src/routes/geocode.ts` — `geocodeAddress`, `ensureCustomerCoords`, `ensureCoordsById`. Sole consumer: `freezeSolve.ts:53,273` (`server.ts:189` imports a type). Persists to `customers.lat / lng / geocoded_at` (`20260726120000_customers_geocoding.sql`) — **data columns that outlive the code**.
- `src/db/scheduleEvents.ts:59-123` — `CommittedRunKind`, `CommittedRun`, `latestCommittedRun` (← `server.ts` only), `findUndoOfRun` (← `server.ts` only), `listEventsByRunStamp` (← `undoRun.ts`, and a *comment* in `booking.ts:852,891`).

**Survivors the demolition edits:**
- `src/schedule/booking.ts:1175-1263` — `setVisitLocks` and its types; imports `listAssignmentsForLockRange`, `updateAssignmentsLocked` (`:25,33`). `rescheduleAssignment` carries `locked` across a move (`src/db/assignments.ts:200`); `createAssignment` accepts it (`:50,79`).
- `src/db/assignments.ts:216-262` — `updateAssignmentsLocked`, `listAssignmentsForLockRange`; sole callers are `setVisitLocks`.
- `src/mcp/server.ts` — the four schemas and cases above; `BOARD_LINK_TOOL_NAMES` entries (`:2038-2044`, four of thirteen); `ServerDeps.geocode / roiTransport / roiMintToken` (`:259-261`); `freezeDeps` wiring (`:6591-6594`, `:6851`); `list_pending_reviews`' token summarizer (`:7765-7810` — special-cases `pending_freeze`/`pending_resolve`/`pending_undo`); `STAGED_ACTION_KINDS` map (`:7890-7892`); the `?startapp=freeze` comment (`:8012`).
- `src/telegram/boardApi.ts:38` (import), `:316-339`, `:594-611`.
- `web/board/board.js` — **83 mentions**: proposal state (`:37-45`), the 📌 Pinned badge (`:146-151`, `:212`, `:755`), `fetchFreezeProposal` (`:536`), `syncFreezePill` (`:567`), `openProposal` (`:720`), the pin toggle (`:1039-1042`, `:1450-1456`). `web/board/index.html` is a 16-line shell.
- `src/db/reviewItems.ts:24-35` — `ReviewKind` members `pending_freeze`, `pending_resolve`, `pending_undo`.
- `src/eval/doctrine.ts:39` — `EXPECTED_SECTIONS` pins the section name.

**Docs that describe it:** `docs/onboarding.md:264-283,352,627`; `docs/nemoclaw-tech-agent.md:105,134,164,255-285`; `scripts/spine-eval/README.md:82`; `scripts/backfill-schedule.mjs:12-13,208-213` (comments only).

## Data Flows

### The staged-token ritual all three run verbs share

```
first call (no confirmId)                         second call (confirmId)
  assembleFreezeInputs ─► solveFreeze/solveResolve   getOpenReviewItem(kind)
  dismiss every open token of this kind             ├─ >12h old  → dismiss "expired (12h)"
  upsertOpenReviewItem(kind, detail:{plan,           ├─ malformed  → dismiss
     scheduleVersion, stagedAt})                     ├─ version moved → dismiss "schedule changed"
  updateOpenReviewItemDetail (pin the plan)          └─ resolveReviewItem('resolved')
  return {needs_confirmation, confirmId,                 runStamp = now
          proposalLink?}                                 commitFreezePlan / commitResolvePlan
                                                           └─ bookVisit / moveVisit per row, each
                                                              event stamped {freezeRun: runStamp}
```
`undo_run` is the same shape with a **15-minute** expiry (`:7142`), reads `latestCommittedRun` and
`listEventsByRunStamp` to build a restore plan, commits through `moveVisit` / `unscheduleVisit` with
`{ undoRun: undoStamp }`. **Run identity lives in `schedule_events.detail` JSON** (`freezeRun`,
`undoRun`) — there is no stamp column (verified: no `%stamp%` / `%run%` column anywhere in `public`).

### The seam with `find_slots` — one direction only

```
  fit.ts ──exports──► addDaysISO, dayWindows, toMin ──► freezeSolve.ts:52
  booking.ts ──exports──► addMinutesClamped, spanMinutes ──► freezeSolve.ts:55
  geocode.ts ──► freezeSolve.ts:53          (nothing else)
  roiClient.ts ──► freezeSolve.ts:54        (nothing else)
  googleRoutes.ts ──► fit.ts:31             (find_slots' travel time — STAYS)

  freezeSolve / freezeProposal / freezeCommit / resolveCommit / undoRun
       ◄── imported by: server.ts, boardApi.ts (projectOpenProposal only), each other, their tests
       ──► imported BY none of fit / booking / availability / policy / boardRead / dateResolve
```
`fit.ts:37` says it in its own words: *"Exported since 4b-3: freezeSolve shares THE minute math (a
second copy could…"*. The export exists *for* the solver; the solver contributes nothing back.
**Nothing has to move.** `boardRead.ts` reads `locked` for display (`:54,77,216,249,315,383,422,507`)
but imports nothing from the five.

### The two Google credentials are cleanly split

| Client | API | Env (name only) | Used by |
|---|---|---|---|
| `googleRoutes.ts` | Routes API `computeRoutes` (`:21`) | `GOOGLE_MAPS_API_KEY` (`:28`; also `server.ts:7589` gates find_slots' "can measure") | `find_slots` — **stays** |
| `geocode.ts` | Geocoding | `GOOGLE_MAPS_API_KEY` (`:27`) | freeze only |
| `roiClient.ts` | Route Optimization `optimizeTours` (`:68`) | `GOOGLE_ROUTES_SA_KEY_JSON` (`:22`) — a service-account JSON, OAuth2, not an API key (`:4-10`) | freeze/re-solve only |

Neither `.env.example` nor `.env.test.example` at the repo root documents `GOOGLE_ROUTES_SA_KEY_JSON`
(the only hits are in `.claude/worktrees/` copies of older docs). Which Render service carries it is
**not verified** here — the freeze runs in the MCP web service, so that is where it would be.

## External Dependencies

- Google Route Optimization API via `google-auth-library` (`package.json:53`) — only `roiClient.ts`.
- Google Geocoding — only `geocode.ts`.
- Google Routes API — `googleRoutes.ts`, stays with `find_slots`.

## Constraints and Invariants

1. **The demolition is bigger than the five files, and the extra reach is inside survivors.** The
   lock verb (`booking.ts:1175-1263`), two board endpoints, ~83 lines of board JS, four schema
   entries, four dispatch cases, a review-item summarizer, a staged-kind map, and three deps fields
   in `server.ts`.
2. **Pinning is doctrine in TWO places.** The §0h section (`:966-1022`) is *refreshed* per bootstrap
   run — the script deletes any existing "## The freeze ritual" block with `awk` and re-appends
   (`:961-963`). But Confirmations clause 5 (`:704-708`) lives in a different section with its own
   append rule; deleting §0h alone leaves a clause instructing pinning for a tool that no longer
   exists. The dates-block clause 8 (`:892`) mentions `get_team_schedule`'s window cover, which stays.
3. **`EXPECTED_SECTIONS` is a hard pin** (`doctrine.ts:39`): `doctrine.test.ts:19-29` fails on a
   section missing from the list *and* on a section present that is not in the list. Removing §0h
   means removing the entry.
4. **The doctrine rollout is a fleet event.** Memory `bootstrap-copy-drift-trap`: six copies of
   `bootstrap-box.sh` on `trades-box-1` at different vintages, ranking changes — md5 every copy
   against the repo before running any. The §0h delete-then-append means a *repo* deletion of the
   block does nothing on a box until the script is re-run there; an old copy would re-append it.
5. **`locked` shares its migration with the promise ladder** —
   `20260714120000_schedule_core_promise_ladder.sql:22` adds `locked` in the same `ALTER TABLE` as
   `promise_level` / `promised_day`. The column can be dropped alone; the migration cannot be
   reverted alone.
6. **Dropping `locked` means recreating `v_schedule`.** The view selects `a.locked` (`20260812110000:39`,
   the current definition). Postgres cannot drop a column a view depends on; the precedent is
   `20260806200000_v_schedule_local_weekday.sql:29` — `drop view if exists v_schedule;` then create.
   `v_schedule`'s column list is printed to the model in `SPINE_VIEW_CATALOG` (`server.ts:763`, "…
   promised_day, locked, earliest_date …"), shared by `query_spine` and `spine_read` (`:1840`), and
   `server.test.ts:8275` asserts the catalog text. The board and `get_team_schedule` (`:4381`) echo
   `locked` as a field.
7. **No CHECK constraint on `schedule_events.kind` or `review_items.kind`** (verified on the local
   stack: zero check constraints on either table). Historic `freeze_committed` /
   `resolve_committed` / `undo_committed` / `lock_updated` event rows and `pending_freeze` /
   `pending_resolve` / `pending_undo` items are append-only (`raise_append_only`) and will remain;
   nothing constrains their `kind` text today, so leaving them costs nothing at the schema.
8. **Repo precedent for dead columns: leave them, annotate them.** Build 6 deleted the `escalate`
   and `leave` verbs but kept `nudges.escalate_after` and `prior_status` (both present on the local
   stack) with a comment — `nudges.ts:550`: *"the column is dormant"*. No migration dropped a column
   for a retired verb.
9. **Tool-surface pins, all hard-coded:** `server.test.ts:2054,2457` (manager sees **46** — "base
   minus get_schedule + **30** admin"), `:189,2334` (technician **17**), `toolCases.test.ts:46`
   (**47** total, "17 technician + 30 admin"), `toolCases.ts:372` (manager **43**), `:398`
   (technician **14**). Four admin tools leave: 46→42, 30→26, 47→43, 43→39. And `toolCases.ts:373,400`
   uses `run_freeze` as the **representative admin tool** in the tier-leak probes — the probe needs a
   substitute, not just a count change.
10. **`run_freeze` is a grader-known staging verb.** `graders.ts:76-78` and `corpus.ts:103-107` list
    the four in the "these verbs stage" sets; `corpus.ts:1139-1145` is a scenario whose whole point
    is *"a pinned visit is left alone and said so"*.
11. **The spine-eval world has two tenants that exist only for these verbs.** `worldSpec.ts:415-416`
    builds `Eval Freeze` and `Eval Resolve` via `buildSolverTenant` (`:914-1000`), one pinned row each
    (`:997`). Worlds are build-once (memory `l1-pins-l2-undeletable`) — after deletion they are dead
    tenants in a world that cannot be rebuilt without the L1 waiver.
12. **`server.test.ts` carries 1,056 lines for the four verbs**: `:6260-6344` (locks), `:6345-6788`
    (freeze), `:6789-7103` (re-solve), `:7104-7315` (undo). `boardApi.test.ts:16` imports
    `PINNED_SKIP_REASON` from `freezeSolve`; `:1592,1601` exercise `/board/api/lock`.
13. **The promise ladder inside the five dies with them; the rest is rung 9's.** 32 `promise`
    references in the doomed modules (freezeSolve 12, undoRun 8, freezeCommit 6, resolveCommit 6) —
    the promise-graded movement freedom in `partitionMovable` (`freezeSolve.ts:929`) and the
    promise carry in the commit paths. Survivors hold 222 (booking 93, server 90, boardApi 25,
    boardRead 10, fit 4) and none of it becomes unreachable by this deletion.
14. **`geocode.ts` and its three customer columns outlive the code that fills them.** After the
    freeze goes, nothing writes `customers.lat / lng / geocoded_at`; nothing reads them either.

## Decision Points

**(a) `roiClient.ts` — delete now, or leave dormant.** *Delete:* it and `geocode.ts` have exactly
one consumer each, `google-auth-library` leaves `package.json` with it, and the repo's precedent for a
retired verb is to delete the code. Rebuilding an advisory optimizer later starts from a 70-line
file that is trivially re-creatable and whose vendor auth rules are recorded in its header. *Leave:*
zero callers, a type-only import in `server.ts`, and a credential nobody mints — the deps seam
(`ServerDeps.roiTransport`) would stay as an unused field. `geocode.ts` is the same question with a
data tail (constraint 14).

**(b) `assignments.locked` — drop the column, or leave it inert.** *Drop:* one migration that
recreates `v_schedule` (precedent exists), plus the catalog string, the `get_team_schedule` field,
`boardRead`'s eight reads, `createAssignment` / `rescheduleAssignment`'s carry, and the board's
badge. *Leave:* nothing reads it once `setVisitLocks` and the solver are gone except display code
that would show a badge nobody can set — so display code goes either way; the column becomes a
dormant `false` on every row, which is the `escalate_after` precedent (constraint 8). The migration
that added it also added the promise ladder (constraint 5), so a later rung 9 migration will touch
this table regardless.

**(c) Historic event and item kinds — leave, or constrain.** No CHECK exists today (constraint 7),
so leaving historic `freeze_committed` / `pending_freeze` rows needs no migration and violates
nothing. Adding a CHECK that grandfathers them is possible but would be the first `kind` constraint
on either table.

**(d) `GOOGLE_ROUTES_SA_KEY_JSON` on Render.** Nothing would read it after deletion. Leaving it is
inert; removing it at deploy is hygiene with a service-account key. Not verified which service holds
it today.

**(e) The board frontend deploys with the repo.** `web/board/board.js` is served by `boardApi.ts:57`
from `BOARD_STATIC_DIR ?? web/board` — same process, same deploy, not a separate app. The 83
mentions (pill, badge, toggle, proposal view, `/board/api/freeze-proposal` probe on every manager
paint at `:536`) are all edits in this repo. The doctrine that tells the agent to end schedule
answers with a board line is untouched — `BOARD_LINK_TOOL_NAMES` just shrinks by four.

**(f) What rung 9 inherits already-dead.** Nothing in the promise ladder becomes unreachable
(constraint 13). What *does* become dead: `customers.lat/lng/geocoded_at`, `ServerDeps.geocode`,
`scheduleEvents.ts:59-123` (`latestCommittedRun`, `findUndoOfRun`, `listEventsByRunStamp`,
`CommittedRun`), and the two solver tenants in the eval world.

## Open Questions

1. **Which Render service carries `GOOGLE_ROUTES_SA_KEY_JSON`?** Not checked (Render MCP not used;
   no `render.yaml` in the repo). The freeze runs inside the MCP web service.
2. **Does any live box's `AGENTS.md` carry a §0h older than `:966-1022`?** Only an md5 sweep of the
   six copies answers it (constraint 4). Not checked.
3. **The two solver tenants in the spine-eval world** — whether the eval harness tolerates a world
   tenant whose verbs no longer exist (`scripts/spine-eval/README.md:82` describes them as
   load-bearing for isolation) needs a read of the world-build script, not done here.
