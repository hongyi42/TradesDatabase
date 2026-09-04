---
date: 2026-09-03
task: "Rung 8 — the schedule is the manager's: delete the autonomous solver and pinning"
research: thoughts/shared/research/2026-09-03-the-schedule-is-the-managers.md
status: draft
supersedes: nothing
---

**`supersedes:`** nothing. The rulings this plan executes are on the record (`docs/engineering-memory.md`
§6a/§8, 2026-09-03). It overturns no document; plans 4b-3 and 2026-07-30 stay as history of what was built.

## Overview

Delete `run_freeze`, `run_resolve`, `undo_run` and `set_visit_locks`, the five solver modules, the two
Google clients only they used, the `locked` column, and every surface that shows or teaches them.
Three phases — the solver, then pinning, then the doctrine and the record — each leaving `typecheck`,
`lint`, `test`, `build` green. One migration. No new behavior; the only new test lines re-pin counts.

## Decisions

- **Delete `roiClient.ts` and `geocode.ts` now** (user, 2026-09-03). One consumer each — the solver;
  `google-auth-library` leaves `package.json` with them. The repo's precedent for a retired verb is to
  delete the code. `customers.lat / lng / geocoded_at` stay as data columns nothing fills or reads; rung 9's.
- **Drop `assignments.locked` now** (user, 2026-09-03). It is in `v_schedule`, which the model is shown in
  the view catalog — an always-false column for a concept the doctrine no longer names is exactly the
  learnability cost the remodel exists to remove. One migration; precedent `20260806200000:29`.
- **Historic event and item kinds stay.** No CHECK constrains `schedule_events.kind` or `review_items.kind`
  (verified); both tables are append-only. Leaving `freeze_committed` / `pending_freeze` rows costs nothing.
- **The eval world drops its two solver tenants at the spec.** `buildWorldSpec` stops building them, the
  verifier stops expecting them, their scenarios go. Worlds already built on the pilot keep two orphan
  tenants nothing reads; the L1 waiver covers cleaning them if anyone cares.
- **`toolCases.ts`'s eval-runner pins are ALREADY stale and get corrected, not preserved** (review). `:372`
  says 43 and `:398` says 14; build 5.5 added three tools and bumped only the vitest pin. Real counts today
  are 46 / 17. They are eval-runner checks (`scripts/spine-eval/lib/mcp.mjs:165` raw `tools/list`), so no
  gate has ever executed them.
- **`boardNotify.ts`'s run-stamp digest heading is deleted, not left dead** (review). `:236-240` reads
  `freezeRun`/`resolveRun` from event detail to head a burst digest; no writer will stamp them again.
- **`GOOGLE_ROUTES_SA_KEY_JSON` comes off Render at deploy** — hygiene for a service-account key with no
  reader; recorded in the deploy notes, done by the user.
- **Phase order solver → pinning → doctrine** so each phase typechecks alone: `boardApi.ts` imports
  `freezeProposal` (Phase 1) and `booking.ts` owns `setVisitLocks` (Phase 2).

## Plain-language walkthrough

**Phase 1 — the solver dies.** The three "let the machine plan the calendar" verbs come out with the
~2,300 lines that built a route-optimisation request, held the proposal behind a confirmation token,
committed it visit by visit, and could undo it. The board's "📋 Freeze proposal" pill goes too. You'd
notice it because a manager's agent no longer lists `run_freeze`, and `npm test` passes with the
solver's test files gone.

```
   BEFORE                                            AFTER
   manager's agent ─run_freeze──► solver ─► plan       manager's agent ─book_visit / move_visit─► rows
                   ─run_resolve─► solver ─► plan
                   ─undo_run────► ledger replay        (find_slots stays: "when is Ben free?")
```

**Phase 2 — pinning dies.** Pinning only ever meant "the solver may not touch this." With no solver it
means nothing, so the verb, the column, the 📌 badge and the board toggle come out, and the view the
model reads no longer lists `locked`. You'd notice it in `get_team_schedule`'s stop objects and in the
catalog text the model is shown.

**Phase 3 — the doctrine and the record.** The box doctrine stops teaching the freeze ritual and stops
telling managers' agents to pin things; the docs are corrected; §6a records the rung as built. The
doctrine change reaches a box only when the bootstrap script is re-run there — and one `awk` line must
*stay* so an old box loses the block rather than keeps it.

## Secrets & env preflight

- **Phase 1:** none. **Phase 2:** none — the migration runs on the local stack; regenerate types with
  `npx supabase gen types typescript --local`, never `npm run gen:types` (it targets the pilot — memory
  `gen-types-points-at-the-pilot`). **Phase 3:** none.

---

## Phase 1: The solver dies

### What this phase does
Removes `run_freeze`, `run_resolve`, `undo_run`, the five solver modules, the two freeze-only Google
clients, the solver's DB helpers and review kinds, the board's proposal surfaces, and every test and eval
case that named them. Manager tool count 46 → 43.

### Changes required

**Delete outright:** `src/schedule/{freezeSolve,freezeProposal,freezeCommit,resolveCommit,undoRun}.ts` and
their four `.test.ts`; `src/routes/{roiClient,geocode}.ts` and their two `.test.ts`.
**`package.json:53`** — remove `google-auth-library`; `npm install` so the lockfile follows.

**`src/mcp/server.ts`**
- Imports `:178-190` (the `freezeSolve` block through the `roiClient` types) and `:194-195`
  (`findUndoOfRun`, `latestCommittedRun`). `findOpenReviewItemsByKind` (`:56`) keeps one live use — stays.
- `ServerDeps` `:259-261` (`geocode`, `roiTransport`, `roiMintToken`).
- Schemas: the objects at `:1197` (`run_freeze`), `:1225` (`run_resolve`), `:1257` (`undo_run`), each to
  the `},` before the next `name:`. `resolve_review`'s description `:1282` ("e.g. a pending freeze").
- `boardMiniAppLink(param?: 'freeze')` `:2056` — drop the parameter. `BOARD_LINK_TOOL_NAMES` entries
  `'run_freeze'`, `'run_resolve'`, `'undo_run'` (`:2046-2050`) with comments.
- Dispatch: `case 'run_freeze'` `:6583-6783`, `case 'run_resolve'` `:6784-7021`, `case 'undo_run'`
  `:7022-7266` (next case `find_slots` `:7267`).
- `list_pending_reviews` (`:7764`): the `pending_undo` branch `:7773-7797` and the freeze/resolve
  summariser `:7798-~7812`; everything falls through to `return item`.
- `STAGED_ACTION_KINDS` `:7890-7892` and the comment above. The `proposalLink` decoration `:8023-8035`
  (`else if (name === 'run_freeze' || …)`): delete the branch and narrow `deco.key` to `'boardLink'`.
  The `?startapp=freeze` comment `:8012`. Comment at `:3442`.

**`src/db/scheduleEvents.ts:59-123`** — `CommittedRunKind`, `CommittedRun`, `latestCommittedRun`,
`findUndoOfRun`, `listEventsByRunStamp` and headers. Keep `:16`, `:40`, `:125`. (`src/db/index.ts:17`
is `export *` — nothing to edit.)
**`src/db/reviewItems.ts:24-35`** — `'pending_freeze'`, `'pending_resolve'`, `'pending_undo'` and comments.
**`src/schedule/booking.ts:852, :890-891`** — comments naming `listEventsByRunStamp`/`undoRun`: reword to
"`eventDetailExtra` exists for callers that stamp a batch identity". No code change.
**`src/telegram/boardApi.ts`** — import `:38`; `findOpenReviewItemsByKind` `:30` and
`latestScheduleVersion` `:34` (only the proposal handler used them); the handler `:316-339` + its comment.
**`src/telegram/boardNotify.ts:236-240`** — the `freezeRun`/`resolveRun` digest heading branch.
The three `case 'freeze_committed' | 'resolve_committed' | 'undo_committed'` push handlers stay for
now and are **deferred to Phase 3, not required to stay** (Phase-1 review). The honest reason is not
the append-only Decisions clause — that protects the DATA and imposes nothing on the code. They are
genuinely unreachable: `pollOnce` seeds `lastSeen` at `latestScheduleVersion(tenantId)` on first
sight of a tenant and only advances, so historic rows are never re-read, and no writer of those
kinds survives. They live only because three tests hand-insert the rows.
**`web/board/board.js`** — proposal state `:37-45`, `fetchFreezeProposal` `:536-552` + call `:468`,
`proposalTitle` `:557-559`, `syncFreezePill` `:567-~600` + calls `:376-380`, `openProposal` `:720-~750`;
`freeze-pill` rules in `board.css` if present.

**Tests and eval**
- `src/mcp/server.test.ts`: delete `describe` blocks `:6345-6788`, `:6789-7103`, `:7104-7315`; lines
  `:2044-2046`; re-pin `:2054` and `:2457` **46 → 43** (comment "+ 30 admin" → 27).
- `src/telegram/boardApi.test.ts`: delete `describe('/board/api/freeze-proposal …')` `:1997-2239` (its
  `stage` helper passes the deleted kinds) and import `:16`. `boardNotify.test.ts:333-471` fixture the
  stamp keys directly and still pass — leave, or delete the digest-heading cases with the branch.
- `src/eval/worldSpec.ts`: `:415-416`, `freeze, resolve,` in the array `:419`, `buildSolverTenant`
  `:913-1021` (JSDoc included). `src/eval/worldSpec.test.ts:370-382`.
- `scripts/spine-eval/verify-world.mjs:203-~215` (the `['Eval Freeze', 'Eval Resolve']` loop).
- `src/eval/toolCases.ts`: cases titled at `:1311`, `:1444`, `:1456` (each the enclosing object); tier
  probes `:373` and `:400` — substitute `cancel_job` for `run_freeze`; **`:398` 14 → 17** (stale, see
  Decisions; `:372`'s stale 43 becomes true after this phase — leave it until Phase 2).
- `src/eval/toolCases.test.ts:46` **47 → 44**; `:110-111`. `src/eval/graders.ts:76-78`.
  `src/eval/corpus.ts:105-107`; scenarios whose `tenant:` is `'freeze'`/`'resolve'` (title lines `:1120`,
  `:1140`, `:1152`, enclosing objects).

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [x] `grep -rnE "run_freeze|run_resolve|undo_run|freezeSolve|freezeProposal|freezeCommit|resolveCommit|undoRun|roiClient|geocode\.js|latestCommittedRun|findUndoOfRun|listEventsByRunStamp|pending_(freeze|resolve|undo)|PINNED_SKIP_REASON|freezeRun|resolveRun|proposalLink|GOOGLE_ROUTES_SA_KEY_JSON" src scripts web package.json` returns **no live code** — corrected from "returns nothing", which was never achievable: a comment explaining that something was removed has to name it. Remaining hits must each be one of: a comment saying the thing is gone, an inert test fixture the plan permitted to stay, or a Phase-3 doc (`scripts/spine-eval/README.md:82`)
- [x] `npx vitest run src/mcp/server.test.ts src/eval/toolCases.test.ts src/eval/worldSpec.test.ts src/telegram/boardApi.test.ts` — the 43 / 17 / 44 pins hold (the 43 lives inside the tests at `:2001` and `:2305`, not a "tool surface" test — run the files)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [x] A fresh-context subagent lists tools as `mgr-test` via `dispatchForIdentity` and reports the
      names: none of the three present; `find_slots`, `book_visit`, `cancel_job` present.
      **Evidence (2026-09-04):** manager list = 43 names, technician = 17. All three verbs ABSENT from
      both. Driven through `dispatchForIdentity`, the three throw `unknown tool: run_freeze` etc. —
      the switch DEFAULT, not a tier refusal, which is the distinction that proves they are gone
      rather than gated. Survivors reach their own argument validation (`book_visit` → "startTime and
      endTime are required", `get_team_schedule` → `{"status":"ok",…}`). Local stack only; scratch
      roster rows and script deleted; `git status` unchanged by the check.

### Manual verification
- [ ] None.

---

## Phase 2: Pinning dies

### What this phase does
Removes `set_visit_locks`, the lock verb, the `locked` column and the view exposing it, and every read
of it — including four places `fit.ts` / `context.ts` carry it that the research did not list. Manager
tool count 43 → 42.

### Changes required

**Migration `supabase/migrations/20260905100000_drop_assignment_locks.sql`** — `drop view if exists
v_schedule;` · `alter table assignments drop column locked;` · `create view v_schedule as …` with the
`20260812110000_v_schedule_excludes_cancelled.sql:30-59` body **verbatim minus the `a.locked,` line** (column
order otherwise unchanged) · `grant select on v_schedule to spine_reader;` · `revoke all on v_schedule
from anon, authenticated;`. `v_cancelled_visits` does not select `locked` (verified). Apply locally,
regenerate types `--local`, confirm `git diff --stat src/db/database.types.ts` is a small deletion.

**`src/mcp/server.ts`** — schema at `:1167` (to the `},` before the next `name:`); `case 'set_visit_locks'`
`:6533-6582`; `'set_visit_locks'` in `BOARD_LINK_TOOL_NAMES` `:2044`; imports `:172`, `:176`; the stop field
`:4382`; `SPINE_VIEW_CATALOG` `:763` — remove `locked, `; model-facing prose naming pinning:
`:998-1000` (get_team_schedule), `:1058-1059` (move_visit "follow up with set_visit_locks"), `:7736-7737`
(find_slots "locked:true was PINNED").
**`src/schedule/booking.ts:1175-1263`** — `VisitLockSelector`, `SetVisitLocksResult`, `setVisitLocks`;
imports `:25`, `:33`.
**`src/db/assignments.ts`** — `:48`, `:83`, `:167`, `:203`, `updateAssignmentsLocked` `:216-235`,
`listAssignmentsForLockRange` `:238-~265`, with comments.
**`src/schedule/fit.ts`** — comment `:436-440`, `DisplacementCandidate.locked` `:449`, the sort tiebreak
`:476-478`, `locked: row.locked` `:497`.
**`src/db/context.ts`** — `:51`, `:129` (a `get_customer_context` field the model sees).
**`src/schedule/boardRead.ts`** — `:54, :77, :216, :249, :315, :383, :422, :507`.
**`src/telegram/boardApi.ts`** — import `:24`; `/board/api/lock` in the allow-list `:352`; handler `:594-611`.
**`web/board/board.js`** — badge `:146-151`, `:212`, `:752-755`; toggle `:1039-1042`, `:1450-1456`; `badge
pinned` rules in `board.css` if present.

**Tests and eval**
- `src/mcp/server.test.ts`: `describe('set_visit_locks …')` `:6260-6344`; `:2043`; `:4155` (`locked: false`
  in a stop `toMatchObject`); `:5655` (`toHaveProperty('locked')` — keep the test at `:5597`, "pin" there
  means a fixed range); pins `:2054`/`:2457` **43 → 42**; add `expect(desc).not.toContain('locked')` to
  the catalog test at `:8275`.
- `src/schedule/booking.test.ts`: `describe('setVisitLocks')` `:1290-~1400`; assertions `:101`, `:409`, `:581`.
- `src/db/scheduling.test.ts`: `:560`, `:570`, `:574`, `:602`, `:613`.
- `src/schedule/fit.db.test.ts:298`. `src/eval/worldSpec.test.ts:350`.
- `src/telegram/boardApi.test.ts`: `/board/api/lock` cases `:1592`, `:1601`; fixtures `:202, :280, :298, :461`.
- `src/eval/toolCases.test.ts:46` **44 → 43**; `toolCases.ts:372` **43 → 42**; case titled at `:872`.
- `src/eval/corpus.ts:103`; scenario titled at `:1139` (F02 at `:1140` is already gone from Phase 1 —
  confirm what remains around it before deleting).
- `src/eval/worldSpec.ts`: `locked:` at `:88, :627, :723, :761, :800, :860, :882, :997, :1128` + comment `:720`.
- `scripts/spine-eval/verify-world.mjs:192` (the `and locked` query) and the `pins >= 1` term `:196-199`;
  `scripts/spine-eval/world.mjs:512`; `scripts/backfill-schedule.mjs:12-13, :208-213` (comments).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] `grep -rnE "\blocked\b|set_visit_locks|pinned" src web scripts --include='*.ts' --include='*.js' --include='*.mjs' | grep -vE "skip locked|pinned by a test|pinned to|pin openclaw"` returns nothing
- [ ] `npx vitest run src/mcp/server.test.ts -t "spine_read schema carries the view catalog"` passes with the new `not.toContain('locked')`
- [ ] Local stack: `\d v_schedule` and `\d assignments` show no `locked`; `no_confirmed_overlap` and `assignment_placed_or_windowed` unchanged (`\d assignments`)

### Live verification (agent-executable)
- Prerequisites: local stack, migration applied.
- [ ] Subagent books a visit as `mgr-test`, calls `get_team_schedule`, reports the stop has no `locked`
      key; `spine_read` over `v_schedule` as `spine:team-lead` returns rows with no `locked` column.

### Manual verification
- [ ] None.

---

## Phase 3: The doctrine and the record

### What this phase does
Removes the freeze ritual from the box doctrine while keeping the line that deletes it from boxes that
already have it; removes the pinning clause; corrects the docs; records the rung.

### Changes required

**`Box_Setup_Stuff/bootstrap-box.sh`** — read `:953-1009` first; the block is
`log` `:959` → `if [ -n "$cid" ]` `:960` → grep+awk delete `:961-963` → heredoc `:964-1004` (`EOF` at
`:1004`) → `ok` `:1005` → `else` / WARN / `fi` `:1006-1008`. The office block begins `:1010`.
- Delete the heredoc **`:964-1004` only**. Keep `:960-963` and `:1006-1008` intact. Reword `:959` to
  `log "freeze-ritual block REMOVED if present (rung 8)"`, `:1005` to `ok "freeze-ritual block absent from
  ${agent}'s AGENTS.md"`, and the WARN at `:1007` to say the removal will run once a container is up.
  Comments `:955-958` reworded to match.
- Confirmations clause 5 `:704-708`: delete; renumber the clauses that follow. This block is
  delete-then-append per run (`:671-675`), so the edit propagates on the next bootstrap.

**`src/eval/doctrine.ts:39`** — remove the entry; `doctrine.test.ts:19-29` then passes both directions.

**`src/telegram/boardNotify.ts`** — the three `case 'freeze_committed' | 'resolve_committed' |
'undo_committed'` handlers deferred from Phase 1 (unreachable: no writer survives and `pollOnce`
never re-reads historic rows), plus the three tests that hand-insert those rows
(`boardNotify.test.ts`, the `resolve_committed` / `freeze_committed` / undo cases).

**Docs** — `docs/onboarding.md:264-277` (four bullets + the "freeze/resolve's job" sentence), `:282-283`,
`:352`, `:627`; `docs/nemoclaw-tech-agent.md:105`, `:134` (the four tool descriptions inside the line),
`:164`, `:255-285` → one line: retired 2026-09-03, rung 8; `scripts/spine-eval/README.md:82-84`;
`docs/engineering-memory.md:4141` (the tool surface is cited as `17/46/47` — it is `17/43/42` after
Phase 2: 17 technician, 43 manager after Phase 1, 42 after Phase 2; the `spineToolNames()` regex pin
goes 47 → 44 → 43); and §6a rung 8 → `[BUILT <date>]` + a `### 8.` section recording what was
deleted, the retained `awk` line, and the deploy notes.

**Deploy notes (user actions):** Phase 2's migration BEFORE the code (deploys run no migrations). Remove
`GOOGLE_ROUTES_SA_KEY_JSON` from the Render web service. Doctrine: md5 all six `bootstrap-box.sh`
copies on `trades-box-1` against the repo (memory `bootstrap-copy-drift-trap`); s2 first, then the fleet.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] `npx vitest run src/eval/doctrine.test.ts` — no unknown and no missing section
- [ ] `bash -n Box_Setup_Stuff/bootstrap-box.sh` parses (the review found the first draft's range would
      have beheaded the next heredoc)
- [ ] `grep -nE "freeze|set_visit_locks|pinned" Box_Setup_Stuff/bootstrap-box.sh` shows only the openclaw
      version-pin lines and the retained delete block
- [ ] `npm run decisions:index` clean

### Live verification (agent-executable)
- Prerequisites: none codified — the box rollout is a deploy-time step.
- [ ] Deferred to rollout: on s2 after re-running the script, `grep -c "The freeze ritual" AGENTS.md` → 0.

### Manual verification
- [ ] Read the renumbered Confirmations block and judge it reads as one list.

---
*Pause after this phase — its Manual verification list is non-empty.*
