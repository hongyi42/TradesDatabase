---
date: 2026-09-06
task: Rung 9c — a visit carries a crew: move the person off the visit row into visit_participants, relocate the double-booking guard with it, and teach every verb and reader that a trip can have several people
research: thoughts/shared/research/2026-09-06-a-visit-carries-a-crew.md
status: draft
supersedes: nothing (thoughts/shared/plans/2026-09-03-a-visit-is-not-a-person.md is already marked superseded; this is the rung that replaces its approach)
---

## Overview
`visits.technician_id` is one nullable column, so two technicians on one trip are two visits nothing
joins: two gaps, two texts, a partner row that never closes. This rung adds `visit_participants` (one
row per person on a visit), moves the `no_confirmed_overlap` guard onto it — with the visit's times
copied there and kept in step by a trigger — and drops `technician_id` after the deploy. **The guard
relocation is proven** (plan-review probe, 2026-09-06, local stack): an exclusion raised from inside
the sync trigger reaches PostgREST as `code: "23P01"`, the parent UPDATE rolls back whole, and a
non-overlapping move syncs the child. So `isOverlapViolation` and `moveVisitRow`'s "nothing changed"
argument survive untouched. Rung 9b's deploy shape is reused: one migration BEFORE the code (with a
bridge so old code keeps working), one AFTER (the drop). Scope is crews only — the stale-confirmed-
visits finding from the 9b deploy is deliberately NOT here.

## Decisions
- **Guard lives on `visit_participants`** *(user, rec. accepted)* — each participant row carries a synced
  copy of `starts_at`/`ends_at`/`status`; the EXCLUDE moves there. App-code-only enforcement was rejected
  (gives up the race safety 9b relies on); a "first technician" column was rejected (a lead by another
  name, contra the 2026-09-01 ruling).
- **A crew gap names ONE participant by a rank-free tiebreak** *(user, rec. accepted)* — the participant
  added first (`visit_participants.created_at`, then `technician_id`); `context.participants` lists the
  whole crew. Every existing ask/attribution/delivery mechanism keeps working; the planner may message
  anyone; only a message to the named person counts as the ask of record. Extending the ask rail to any
  participant is a recorded follow-up, not this rung.
- **Every verb takes `technicianRefs: string[]`; `technicianRef` stays as shorthand** *(user, rec.
  accepted)* — on `move_visit` the list REPLACES the crew; `unassign:true` clears it. No new verb.
- **The pilot's existing crew pair stays two visits** *(user, rec. accepted)* — the backfill maps every
  row with a `technician_id` to exactly one participant; nothing guesses.
- **One participant's note closes the whole visit** *(from the 2026-09-01 ruling)* — attach step 1 becomes
  "this technician is a participant, or there are none". The partner-row bug disappears by construction.
- **`technician_id` is DROPPED in the second migration — and until then it is a BRIDGE, written by new
  and old code alike** *(mine, from the no-lead ruling + the 9a column-drop pattern; plan review F1)*.
  The typed layer keeps writing `technician_id = technicianIds[0] ?? null` until Phase 4. This is not a
  lead: it exists so every phase stays green (14 readers still read the column until Phase 3), so the
  deploy window has no stale-column false `23P01`s, and so `v_schedule` stays right until it is rebuilt.
  ONE trigger materialises that person as participant #1; the typed layer upserts the rest.
- **ONE trigger function on `visits`, and its order is load-bearing** *(review F3, probed)* — AFTER
  triggers fire alphabetically, and "sync times" before "reconcile person" refuses a legitimate
  reassign-and-move (the leaver's copy is moved onto a slot they hold elsewhere). So: one function,
  `technician_id` reconciled FIRST (delete the OLD person's row, upsert the NEW), THEN times/status synced
  to the remaining rows. Pinned by a test that does exactly that move.
- **Planner views get arrays, plus a participants view** *(mine)* — `v_schedule`/`v_cancelled_visits`
  keep one row per visit with `technician_refs text[]`/`technician_names text[]`; new
  `v_visit_participants` for joins. One row per participant would make `count(*)` count people again.
- **The board stays working with zero client change** *(mine; user is rebuilding it)* — the day read emits
  one stop PER PARTICIPANT sharing a `visitId`, so `board.js`'s lanes need nothing; the self-view gates
  become membership tests; the detail sheet's `technicianRef` is the first participant for its picker.
- **`createVisit` keeps accepting `technicianId`** *(mine)* — sugar for `technicianIds: [id]`, so 119
  test fixtures and four seed scripts do not churn; new fields are additive.
- **Write order for crews** *(mine; review F2 probed the wrong order)* — `createVisit` inserts the visit
  (bridge column = first person → the trigger makes participant #1) then upserts every id
  (`onConflict:'visit_id,technician_id', ignoreDuplicates`); on `23P01` it deletes the fresh visit row and
  rethrows. **Safe ONLY there** — the row has no `schedule_events` yet; once one points at it, `ON DELETE
  SET NULL` trips `raise_append_only` and the delete raises. A move with a crew change goes **delete
  leavers → UPDATE times (+ bridge column = first of the new crew) → upsert joiners**: the UPDATE's guard
  then checks only who is staying, so "Ben can't make Tuesday, send Joy" is not refused because of Ben's
  Tuesday. If the UPDATE raises, leavers are re-added at the old time (advisory) and the error rethrown;
  a `23P01` while adding a joiner is reported as "moved, but could not add X" — never silent.
- **"No person" = no participant rows, anti-joined in JS** *(mine)* — the
  `listUnscheduledOpenJobsWithCustomer` precedent (`visits.ts:826-841`).
- **Out of scope** — stale-confirmed visits defeating attach step 2; any-participant ask-of-record; the
  board rebuild; rungs 10–12.

### Amended during Phase 4
- **The deploy's second window is NOT free, and the plan said it was.** Removing the bridge writes in
  the same commit the services ship means that between "five services live" and migration 2 the
  catalog names views that do not exist, new bookings leave the old `v_schedule`'s `technician_ref`
  empty, and the still-live `no_confirmed_overlap` reads a stale column (a possible FALSE "has NOT
  moved"). Migration 2 moved to immediately after `live`, before the seat restarts and before any
  tick. Nothing is papered over; the window is made short and its cost is written down.
- **The date-eval ground truth counts TRIPS, not people.** The join rewrite turned one crew visit
  into N rows, so `dayCounts` would have graded the agent's (correct) "1 visit" against a manifest
  saying 2 — a false failure on every count question covering a crew day. The crew is a subquery now,
  never a join, in all three eval scripts.
- **The catalog's worked example must join `v_schedule`.** `v_visit_participants` carries every trip
  including CANCELLED ones and has no `local_day`, so an example that counted it directly would have
  taught the agent to report called-off work as work done — a recorded live incident
  (engineering-memory L1308) — and to bucket evening visits on the wrong UTC day.
- **A move that loses its only joiner to a race lands a trip with NOBODY on it** (the Phase 2
  carry-forward). With the bridge gone, `upsertParticipants` is the only thing that puts a person on
  a visit. The warning and the MCP result now say so outright.
- **The §9c record's own entries have to be `- **Title**` bullets** or `decisions:index` cannot lift
  them into the map every session is told to grep.

### Amended during Phase 3
- **`unassigned` COUNTS people, it does not name them.** A visit held by a technician whose roster
  row belongs to another tenant is a trip we cannot put a NAME on, not an empty one. Deriving
  `unassigned` from the nameable crew would have offered an occupied visit to the tray; it now reads
  `participantIdsOf(...).length === 0` in boardRead, context and the MCP schedule reads.
- **`find_slots` excludes the subject's stop from EVERY crew member's day**, not the first one's. A
  crew trip sits on both their days, so scoring the other member's candidates against a route that
  still contains the stop being moved understates the drive.
- **`listCostGapCandidates` is paged** for the same reason the Phase 1 readers are: its "somebody is
  on it" filter moved from SQL to JS.
- **`listVisitsForCustomer` re-sanitises its own rows.** It is returned RAW to `get_customer_context`
  and spread into the agent's result, so it cannot rely on `participantsOf`'s tenant re-check the way
  every other reader does.
- **The watcher names the crew from the ROSTER read**, the same source as the addressee — two name
  sources for one crew is how a gap ends up addressed to "Ben Shelton" while listing "ben-shelton".
- **Two tests were vacuous until fixed**: the crew attach test passed under a single-column rule
  because step 2 rescued it (the job needs a second live visit for step 1 to be the deciding rule),
  and the board crew test asserted as the bridge-column holder, which a pre-9c reader also finds.

### Amended during Phase 2
- **A present-but-empty `technicianRef`/`technicianRefs` is REFUSED by the verb**, not read. `''`
  used to mean "keep the crew" and `[]` means "park it" — two readings of the same accident, and the
  two surfaces already refuse both at their own edge. The shared verb is now the floor under them.
- **A race names only the joiner who is actually busy.** One collision rolls the whole upsert back,
  so every joiner is missing — calling them all busy tells the manager something false about the
  innocent one. The warning re-checks each at the new slot.
- **`move_visit`'s singular `technicianRef` says it REPLACES the crew**, like its plural sibling. An
  agent told "send Joy too" that reached for the singular field would silently drop Ben.
- **Carried into Phase 4:** once the bridge column goes, `upsertParticipants` becomes responsible for
  participant #1, and a joiner failure after the leavers were removed can leave a trip with NOBODY on
  it. Neither `moveVisit`'s warning nor the MCP result would say so today. Phase 4 must cover it.

### Amended during Phase 1 (probed on the local stack, 2026-09-06)
- **SURROGATE PRIMARY KEY on `visit_participants`, not (visit_id, technician_id)** — PostgREST reads a
  two-FK table whose PK is exactly those FKs as a JUNCTION and synthesises a many-to-many
  `visits ↔ technicians` that collides with `visits_technician_id_fkey`. Every select embedding
  `technicians` from `visits` then answers HTTP 300 `PGRST201` — which would have broken the
  still-running old code for the entire deploy window, the one thing the migration order exists to
  prevent. `id uuid primary key` + `unique (visit_id, technician_id)` gives the same guarantee and
  keeps the relationship unambiguous (probed: 200 on all four embed shapes). Pinned by a schema test.
- **The five embed selects KEEP `technicians(...)` and ADD the participants embed** rather than
  replacing it (the plan said replace). The plan also said the `technicians` member stays on the row
  types until Phase 3 — replacing the select would have left it typed but always undefined, i.e. no
  technician names on the board for two phases. Both resolve now; Phase 3 removes the old one.
- **The bridge column keeps whoever already holds it** if they are still on the crew (`bridgeFor`),
  instead of always taking the first of the list. The trigger's bridge arm deletes the OLD
  column-holder's participant row, so re-stating the same crew in a different order silently dropped
  a STAYING member and skipped their overlap check — the move then landed on top of their own
  booking (review round 1, probed).
- **`on conflict (visit_id, technician_id) do nothing`, never a bare `on conflict`** — an untargeted
  DO NOTHING arbitrates over every constraint, the exclusion included, so the relocated guard was
  unenforced on the trigger's own insert path (review round 2, probed).
- **The fill trigger fires on INSERT *or UPDATE* and takes `for share` on the visit** — without
  either, a participant's derived times can drift from its trip (a direct UPDATE, or an insert racing
  a move), and the guard is then checking a time nobody is going.
- **The three tenant-wide readers are PAGED** — the "nobody is on it" test moved from SQL to JS, so
  SQL now returns every confirmed row in the window and PostgREST's 1000-row cap would truncate
  before the filter ran. The tray reads from the epoch, and untimed rows sort last, so they are
  exactly what would have been dropped.
- **`isOverlapViolation` excludes a joiner failure** — both carry 23P01, but one means "nothing
  moved" and the other means "it moved and one person is missing". Reporting the first for the second
  tells the manager the opposite of what happened.

## Plain-language walkthrough
```
      visits ──< visit_participants >── technicians
   (one row/trip)  (one row/person on it; carries a synced copy of the trip's
                    times so the "nobody booked twice" rule can live here)
```
**Phase 1 — the table and the typed layer.** A new table lists who is on each visit, with the trip's
times copied onto every row by a trigger, and the double-booking rule moved onto it. The same trigger
turns whatever is written into the old column into "person #1", so the code running today keeps working
unchanged while both exist. The typed layer (`src/db/visits.ts`) learns to create, replace and read crews. You'd notice: a
visit can hold two people, and booking one of them twice in the same hour still fails loudly.

**Phase 2 — the verbs.** `book_visit` and `move_visit` accept a list of people; a single name still
works. Moving a visit re-checks every person's calendar. The change log and the phone pushes name
everyone who joined or left. You'd notice: "send Ben and Joy on Tuesday at 2" is one call.

**Phase 3 — the readers.** A note from either crew member closes the trip. An unreported crew visit
raises ONE gap, addressed to one of them with both listed. Occupancy, the cost gap, the customer
brief and the board all count a crew as one trip and show every name. You'd notice: one text, not two.

**Phase 4 — the planner's SQL, the column drop, the docs, and the deploy.** The views the planner
queries show one row per visit with a list of names. `technician_id` goes. Docs and seat doctrine say
"crews are one visit". Deploy in the proven order: migration 1 → sync the fork → five services → seat
gateways → migration 2 → a real two-person booking through a seat, read back from the pilot.

## Secrets & env preflight
- **Phases 1–3:** none beyond `.env.test` (local stack, `already required`).
- **Phase 4:** `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_URL` in `.env` (pilot, embed probes),
  `RENDER_API_KEY` in `.env` (deploy polling), `ssh tradesbox` access, push rights on the
  `Yu-C1/TradesDatabase` fork — all `already required` and verified 2026-09-06.

## Phase 1: `visit_participants` and the typed layer

### What this phase does
Adds the table, the relocated guard, the two sync triggers, the deploy-window mirror trigger, and the
backfill — all in one migration that the currently deployed code survives. Rewrites `src/db/visits.ts` so
every write goes to participants and every reader returns them, keeping every existing function name
and signature. Old `no_confirmed_overlap`, `idx_visits_technician` and the column stay until Phase 4.

### Changes required

**`supabase/migrations/20260907100000_visit_participants.sql`** (new)
```sql
create table visit_participants (
  tenant_id     uuid not null references tenants(id),
  visit_id      uuid not null references visits(id) on delete cascade,
  technician_id uuid not null references technicians(id),
  starts_at timestamptz, ends_at timestamptz, status visit_status not null,  -- synced copies
  created_at    timestamptz not null default now(),
  primary key (visit_id, technician_id),
  constraint no_confirmed_overlap_participant exclude using gist
    (technician_id with =, tstzrange(starts_at, ends_at) with &&)
    where (status = 'confirmed' and starts_at is not null)
);
create index idx_visit_participants_technician on visit_participants(technician_id, starts_at);
create index idx_visit_participants_tenant_visit on visit_participants(tenant_id, visit_id);
revoke all on visit_participants from anon, authenticated;
```
- Trigger `visit_participants_fill`: `before insert on visit_participants` — copy `starts_at, ends_at,
  status` from the visit (callers pass only `tenant_id, visit_id, technician_id`); raise
  `'visit_participants: tenant mismatch'` when `tenant_id` differs from the visit's.
- **ONE** function `visits_reconcile_participants()`, trigger `visits_participants_after` — `after insert
  or update of technician_id, starts_at, ends_at, status on visits`, in this order inside the body:
  (1) if `technician_id` changed: `delete … where visit_id = new.id and technician_id = old.technician_id`
  (never delete-all — a crew's other members are the typed layer's business), then `insert … on conflict
  do nothing` for `new.technician_id` when not null; (2) `update visit_participants set starts_at, ends_at,
  status … where visit_id = new.id`. The exclusion fires from (2) on a collision; the probe proved the
  whole statement rolls back and PostgREST returns `23P01`. Step (1) is dropped in Phase 4 with the
  column; step (2) is permanent.
- Backfill: `insert into visit_participants (tenant_id, visit_id, technician_id) select tenant_id, id,
  technician_id from visits where technician_id is not null;` — 390 pilot rows (measured; the earlier 422
  was a subtraction, not a count); cannot raise, because the visits-level guard already holds the same
  predicate over the same tuples. Header states the order: **BEFORE the deploy, and BEFORE syncing the
  fork** (9b lesson: the auto-deploy services ship on the sync).

**`src/db/visits.ts`**
- `export type VisitParticipant = Database['public']['Tables']['visit_participants']['Row']`;
  `export interface ParticipantRef { technicianId: string; ref: string; displayName: string }`.
- `CreateVisitInput`: add `technicianIds?: string[]`; keep `technicianId?: string | null` as sugar
  (`[id]`). `createVisit` (:52-85): insert the visit with the BRIDGE `technician_id: ids[0] ?? null`
  (the trigger makes participant #1), then `upsertParticipants(all ids)`; on error delete the fresh visit
  (`.from('visits').delete().eq('id', …)`, advisory) and rethrow with `code` preserved.
- New `upsertParticipants(tenantId, visitId, technicianIds)` — `onConflict:'visit_id,technician_id',
  ignoreDuplicates:true`, one statement; new `setVisitParticipants(tenantId, visitId, technicianIds)` —
  delete rows not in the set, then upsert the set (the bridge row is a duplicate → ignored). New
  `listParticipants(visitId)` and the ONE tiebreak `orderParticipants(rows)` = by `(created_at,
  technician_id)`.
- `moveVisitRow` (:182-231): `MoveVisitRowInput.technicianIds?: string[]` (undefined = keep; `[]` =
  detach). Order: delete leavers → the one UPDATE (times, status, bridge `technician_id = ids[0] ??
  null`) → upsert the set; on a `23P01` from the UPDATE, re-upsert the leavers (advisory) and rethrow.
- `attachVisitTechnician` (:238-277) → `attachVisitParticipants(id, {technicianIds, reason, status})`,
  same order minus the times.
- Readers via participants, same names and signatures: `listVisitsForTechnician` (:508-527) →
  `.from('visit_participants').select('visits!inner(*)').eq('technician_id', …)` on the synced columns,
  then `.map((r) => r.visits)` — the `listNoteTimesForJobs` (:936) precedent, 200 on local PostgREST;
  `listUnassignedVisits` (:550-575), `listIdenticalUnassignedVisits` (:662-690), `listUntimedVisitsForJob`
  (:727-757), `listUnassignedVisitsWithRefs` (:772-799): embed `visit_participants(technician_id)` and
  filter in JS. The five embed selects (:442, :481, :618, :692, :957) replace `technicians(…)` with
  `visit_participants(technician_id,created_at,tenant_id,technicians(id,ref,display_name,tenant_id))`;
  new `participantsOf(row, tenantId): ParticipantRef[]` applies the tenant re-check on BOTH levels and
  the tiebreak order. The same embed is ADDED to `listOverdueConfirmedVisits` (:580-596),
  `listVisitsForTenant` (:377-394) and `listUnassignedVisits` (:550-575) — `fit.ts`, `get_team_schedule`
  and `find_slots` read through those and had no participants source otherwise (review §3).
- `VisitDetailRow`, `VisitDayRow`, `CustomerUpcomingRow`, `UnplacedStripRow`, `VisitWithTechnician`: ADD
  `visit_participants: Array<{…}>` BESIDE the existing `technicians` member (kept until Phase 3 so
  `boardRead.ts:162,431`, `context.ts:111`, `synthesis/grounding.ts:78` and `synthesis/fixtures.ts:45-49`
  keep compiling); `listVisitsForTenant`'s return widens additively.
- `npm run gen:types:local` (never `gen:types` — it targets the pilot).

### Automated verification
- [x] `npx supabase db reset` applies the migration; `npm run typecheck` · `lint` · `test` · `build`
- [x] `src/db/schema.test.ts`: `visit_participants` exists with `no_confirmed_overlap_participant`;
      `visits.technician_id` still present (inverted in Phase 4); ONE trigger on `visits` named
      `visits_participants_after` and none named `*sync*`/`*mirror*` (the order pin, review F3)
- [x] `src/db/scheduling.test.ts` — re-point :292 (overlap raised on the PARTICIPANT insert), :414 (move
      onto a taken slot: `23P01` from the sync trigger, visit EXACTLY where it was), :706 (untimed twins
      insert). New: two ids → two participants; a `23P01` on the second person leaves NO visit row behind;
      set-participants with a colliding add leaves the crew intact; sync trigger moves every participant's
      copy; mirror trigger turns an old-style `technician_id` UPDATE into one participant; the tiebreak
      order; `listVisitsForTechnician` finds a visit through a participant row; the four "nobody" readers
      return only zero-participant rows; **old-style `moveVisitRow({technicianId: B})` onto a slot the
      OLD person A holds elsewhere SUCCEEDS** (the F3 order pin — fails under the wrong trigger order);
      `listOverdueConfirmedVisits` returns a two-participant visit ONCE (db test — `watchers.test.ts`
      mocks this reader, so only a db test can see a fan-out).
- [x] Test-count audit: added ≥ 11, deleted 0 (the rung-9a mass-edit rule).

### Live verification (agent-executable)
- Prerequisites: local stack only.
- [x] `docker exec … psql`: after `db reset` + `npm run seed:local`, `select count(*) from
      visit_participants` equals `select count(*) from visits where technician_id is not null`.

### Manual verification
- [ ] none

---

## Phase 2: the verbs, the ledger, the pushes

### What this phase does
Every schedule verb takes a crew. Booking and moving pre-check every person, the change log records who
joined and who left, and the Telegram pushes reach all of them.

### Changes required

**`src/schedule/booking.ts`**
- `BookVisitInput` (:146): add `technicianRefs?: string[]`; `resolveBooking` (:240-…) resolves the union
  of `technicianRef` + `technicianRefs`, deduped, each via `resolveTechnician` (an unknown ref names
  itself in the error); `overlappingConfirmed` (:127-135) runs per person; `createVisit` (:479) gets
  `technicianIds`. `BookVisitPreview`/`BookVisitResult` (:373, :440): add `technicianRefs`,
  `technicianNames`, `participants`; keep `technicianRef`/`technicianName` = first-or-null for callers.
- `MoveVisitInput` (:530): add `technicianRefs?: string[]`; `resolveMove` (:557-600): target crew =
  `unassign ? [] : refs given ? resolve(refs) : current participants`; availability warning and overlap
  pre-check per target person, excluding the moved row. `moveVisit` (:694-…): `moveVisitRow(times,
  technicianIds)` in the delete-leavers → UPDATE → upsert-joiners order; a `23P01` from the UPDATE is
  the existing "has NOT moved" message; a `23P01` from a joiner is `moved to <day time>, but <name>
  already has a confirmed visit there — they were NOT added`. `MoveVisitResult.previousTechnicianIds`.
- `attachUnplacedVisit` (:822-926): `technicianRefs`; `attachVisitParticipants`.
- Ledger detail: `booked` → `technicianRefs`; `moved` → `technicianRefs`, `previousTechnicianIds`;
  attach's `moved` → `attachedTechnicianRefs`, `previousTechnicianIds`. Old keys are not written.
- `previewCancelJob` (:1039-1060): `technicianRefs` per visit (keep `technicianRef` = first-or-null).

**`src/telegram/boardNotify.ts`**
- `technicianOf(row)` (:101) → `liveParticipants(row)`: every current participant through
  `liveTechnician`. `moved` (:118-160): old set = `detail.previousTechnicianIds` (fallback
  `previousTechnicianId`, then `previousAssignmentId`); per person: in both → "Your visit moved";
  only-new → "landed on your schedule"; only-old → "moved off". `booked`/`cancelled`: one push per
  participant.

**`src/mcp/server.ts`**
- `book_visit` schema (:1016-1050) and `move_visit` (:1053-1082): add `technicianRefs: {type:'array',
  items:{type:'string'}}`; describe `technicianRef` as shorthand for one person and `technicianRefs` as
  the crew (on move: REPLACES it). Handlers (:4314, :4438): parse the array (each item a non-empty
  string), reject `unassign` + refs together (the :4448 idiom). Results: `technicianRefs`, `crewNote:
  'N people are on this visit'` when N > 1.

**`src/telegram/boardApi.ts`** — book (:370-382), attach (:527-563), move (:575-607): accept
`technicianRefs` alongside `technicianRef` with the same present-but-empty refusals. `board.js` is
unchanged (it sends the shorthand).

### Automated verification
- [x] `typecheck` · `lint` · `test` · `build`
- [x] `booking.test.ts`: book two refs → two participants + one `booked` event carrying both; an unknown
      second ref is refused by name and NO visit is left behind; move with `technicianRefs` replaces the
      crew and the event carries `previousTechnicianIds`; move onto a slot one crew member holds elsewhere
      is refused per person BEFORE the write; **reassign-and-move where the LEAVER is busy at the target
      succeeds** (review F2); the joiner-failure message; `unassign:true` empties it.
- [x] `boardNotify.test.ts`: a booked crew → one push each; a reassignment → the leaver told, the joiner
      told; a historical `previousTechnicianId` still resolves.
- [x] `server.test.ts`: `technicianRefs` on book and move, `crewNote` present for N > 1; the catalog
      regression pin that `technicianRef` still works alone.
- [x] `boardApi.test.ts`: `technicianRefs` accepted on all three routes.

### Live verification (agent-executable)
- Prerequisites: local stack.
- [x] none beyond the suite (all codifiable).

### Manual verification
- [ ] none

---

## Phase 3: the readers

### What this phase does
Everything that inferred "the person" from one column reads the crew instead: the attach rule, the gap
mint, the cost gap, occupancy, the board reads, the customer brief, the fold preview.

### Changes required

**`src/writePath/attachNote.ts`** (:77-93) — step 1's person clause becomes
`participantsOf(v).length === 0 || participantsOf(v).some(p => p.technicianId === input.technicianId)`;
`listVisitsForJob` gains the participants embed for it. Header comment updated.

**`src/jobs/watchers.ts`** (:600-635) — `const crew = participantsOf(g, tenantId)`; `technicianId =
crew[0]?.technicianId ?? null`; context keeps `technicianRef/Name` for the named one and adds
`participants: [{ref, name}]`. `techById` lookups for the named person only.

**`src/db/jobs.ts`** `listCostGapCandidates` (:222-282) — embed participants; drop rows with none; the
person is the tiebreak-first participant, so the crew tie is deterministic (Constraint 9 of 09-02).

**`src/schedule/fit.ts`** — `assembleFitContext` (:388-406): `rows` keep rows with ≥1 participant;
`mine = rows.filter(r => participantsOf(r).some(p => p.technicianId === t.id))`. Displacement
(:474-484): `technicianRefs`. `techDateKey` unchanged (per person-day is correct).

**`src/schedule/boardRead.ts`** — day grid (:136-175): TEAM view (no `viewerTechnicianId`) emits one
`BoardStop` per participant sharing a `visitId`, so the lanes need nothing; SELF view emits ONE stop
(the flat layout, `board.js:186-190`, would otherwise draw a crew visit twice). `unassigned` = no
participants; viewer filter (:140) and detail gate (:422) = membership. `VisitDetail` (:358): add
`technicianRefs`, `technicianNames`; `technicianRef` = first-or-null. Drop the `technicians` member from
the five row types here, and update `synthesis/grounding.ts:78`, `synthesis/fixtures.ts:45-49`,
`context.ts:111` and the local type at `server.ts:6019-6025` in the same phase.

**`src/mcp/server.ts`** — `get_team_schedule` stops (:4181-4195) and untimed list (:4232-4233):
`technicianRefs`, `unassigned` = none; `counts` unchanged (now one row per crew — correct for free).
`book_visit` result (:4410): `unassigned` = no participants. `find_slots` (:6307-6308): the subject's
participants' refs. `SPINE_VIEW_CATALOG` untouched until Phase 4.

**`src/db/context.ts`** (:100-125), **`src/db/foldImpact.ts`** (:92, :132) — `technicianRefs` /
`technicianIds`; `unassigned` = none.

**`src/writePath/identityMatch.ts`**, **`src/routes/daySource.ts`** — no change (their reader was
re-sourced in Phase 1). **`src/eval/plannerSim.ts`** — no change (visit seeding uses the sugar).

### Automated verification
- [x] `typecheck` · `lint` · `test` · `build`
- [x] `recordFieldNote.test.ts`: a crew of two, either person's note attaches to THE visit and marks it
      `completed` — **the closing case files as the SECOND-added participant**, or the partner-row bug can
      regress unseen; a non-participant technician's same-day note falls to step 3 and creates one.
- [x] `watchers.test.ts`: an unreported crew visit → ONE observation, `technician_id` = the first-added
      participant, `context.participants` both; a note by the OTHER participant still suppresses it
      (job-scoped freshness).
- [x] `jobs` cost-gap test: a crew names the same person on every run.
- [x] `fit` test: a crew visit occupies BOTH people's days. `boardRead`/`boardApi` tests: team view shows
      a crew stop in both lanes with one `visitId`; the second person's self-view contains it EXACTLY
      ONCE (length assertion — `boardApi.test.ts:293`'s count passes today only because its fixture has
      no crew); the detail 404s for a non-participant.
- [x] Test-count audit as in Phase 1.

### Live verification (agent-executable)
- Prerequisites: local stack.
- [x] none beyond the suite.

### Manual verification
- [ ] none

---

## Phase 4: the views, the column drop, the doctrine, the deploy

### What this phase does
Rebuilds the two planner views around participants, drops `technician_id` and its guard, updates the
catalog prose, docs and seat doctrine, then deploys in the 9b order and proves a crew end to end.

### Changes required

**`supabase/migrations/20260907100100_drop_visits_technician_id.sql`** (new; **AFTER all five services
are live**): drop trigger mirror; `drop view` `mv_whiplash`, `v_schedule`, `v_cancelled_visits`
(DROP+CREATE precedent); recreate both with `technician_refs text[]`, `technician_names text[]`
(`select array_agg(t.ref order by p.created_at, p.technician_id) … from visit_participants p join
technicians t … where p.visit_id = v.id`); create `v_visit_participants(visit_id, technician_ref,
technician_name, created_at)` with BOTH `p.tenant_id = current_setting('spine.tenant_id')::uuid` AND the
`p.tenant_id = v.tenant_id` wall (the `v_visit_notes` shape — the GUC alone was missing, review §6);
recreate `mv_whiplash` verbatim (it references only `visits.id/job_id`; confirmed by `pg_depend`);
re-grant `spine_reader`, revoke anon/authenticated; drop the `technician_id` arm of
`visits_reconcile_participants()`; then `alter table visits drop constraint no_confirmed_overlap`, `drop
index idx_visits_technician`, `alter table visits drop column technician_id`. Header states BOTH wrong
orders (the 9a idiom). `stage` is pinned by `scheduling.test.ts:520` and `schema.test.ts:160`.

**`src/db/database.types.ts`** — `gen:types:local`; the typed layer stops writing the bridge column;
`upsertParticipants` now makes participant #1 too. **The column drop's blast radius, every site named
(review §3):** `schema.test.ts:124` (invert) and `:207-227` (two tests pin `no_confirmed_overlap` ON
`visits` → move to the participant constraint); `booking.test.ts` (12 reads of `.technician_id`);
`scheduling.test.ts:350,378,386,1034,1036`; `server.test.ts:438-444,6151-6154,6192-6195`;
`boardApi.test.ts:761,1020,1053,1073,1515` (RAW `insert into visits (… technician_id …)` → SQL error)
plus reads at `:589-657` and `:1189-1405` — the cross-tenant test at `:1017-1106` must insert a
`visit_participants` row directly (the fill trigger checks the row's tenant against the VISIT's, not the
technician's); `costGapCandidates.test.ts:61-66` (raw insert); `watchers.test.ts:781-804,967`
(fixtures). Classify each as delete / invert / re-source and account for the count.

**`src/mcp/server.ts`** — `SPINE_VIEW_CATALOG` (:742-752): the array columns + `v_visit_participants`;
the worked example (:1200) → `select p.technician_name, count(*) from v_visit_participants p group by 1`.
**`src/teamLead/plannerPrompt.ts`** — any `technician_ref` mention on v_schedule.
**`src/eval/corpus.ts`** (:348), **`scripts/date-eval/{plan,run-direct,adjudicate-db}.mjs`**,
**`scripts/spine-eval/verify-world.mjs`** (:63,:74,:83,:186), **`scripts/smoke-http.mjs`** (:181) — raw
SQL/selects on `a.technician_id` → participants; `node --check` each `.mjs`.

**Docs** — `docs/Three-Layer-Context-Spine-Overview.md` (the visit bullet: "one or more technicians";
`visit_participants` in the L2 picture), `docs/onboarding.md` §4d, `docs/engineering-memory.md` (ladder
`9c BUILT`, a §9c record incl. the probe), `docs/nemoclaw-tech-agent.md`, `Box_Setup_Stuff/bootstrap-
box.sh` rule 5 (+1 sentence: "to send two people, pass technicianRefs"), 2026-09-02 research gets a
superseded pointer to this plan. `npm run decisions:index`.

**Deploy order** — 0. re-check pilot captures (3-day count), open cancel tokens, and
`select to_regclass('public.assignments')` is null (a surviving 9b compat view would make the column
drop fail); 1. `apply_migration` `20260907100000`; read back
`count(visit_participants) == count(visits where technician_id not null)`, the constraint on
`pg_constraint`, both triggers; probe
`visits?select=*,visit_participants(technician_id,technicians(ref))&limit=1` → 200 AND
`visits?select=id,technicians(ref)&limit=1` → 200 (the junction check: a 300 here means the surrogate
key was lost); 2. sync the fork; 3. deploy `TradesDatabase`, `lifecycle-heart`, `Board_Worker`
(autoDeploy off) and verify all five `live`; **4. `apply_migration` `20260907100100` IMMEDIATELY** —
read back `information_schema.columns` has no `visits.technician_id`, schema md5 pilot == local;
5. `nemoclaw <s> gateway restart` on s2, then s3 s5 s6 s7 s8 (arg schemas changed); 6. one clean
`lifecycle-heart` tick.

**WHY MIGRATION 2 MOVED UP, and what the remaining window costs** (Phase 4 review). The first
window — migration 1 applied, services still on the old commit — degrades NOTHING: the column, its
guard and its index all survive, and the trigger's bridge arm keeps participants true while the old
code writes the column. The SECOND window, between the services going live and migration 2, is not
free, because this rung's commit stops writing the bridge column:
  * the new `SPINE_VIEW_CATALOG` names `technician_refs` and `v_visit_participants`, which do not
    exist until migration 2 — a planner tick in that window gets 42703/42P01 on a `spine_read`;
  * visits booked in the window leave `technician_id` NULL, so the still-live OLD `v_schedule`
    shows `technician_ref` empty for them;
  * the still-live `no_confirmed_overlap` on `visits` reads a now-stale `technician_id`, so moving
    a pre-9c visit whose original holder is leaving the crew can be refused with a false
    "already has a confirmed visit … the visit has NOT moved".
None of it corrupts data, and all three end the moment migration 2 lands — so the window is made as
SHORT as possible (migration 2 immediately after `live`, before the seat restarts and before any
deliberate tick) rather than papered over. Do not run a `lifecycle-heart` tick inside it.

### Automated verification
- [x] `db reset` applies both; `typecheck` · `lint` · `test` · `build`; `node --check` on 5 `.mjs`
- [x] db test: `v_schedule` returns ONE row for a two-person visit with both refs in order;
      `v_visit_participants` walls the tenant; the catalog pin names the new columns and not `technician_ref`.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, `RENDER_API_KEY`, `ssh tradesbox`, fork push rights.
- [ ] The window, stated HONESTLY (corrected in Phase 4 review — the original claim that nothing
      degrades in either window was wrong once the bridge writes were removed in this same commit):
      window 1 is clean; window 2 costs a broken catalog, empty `technician_ref` on the old view, and
      a possible false overlap refusal — see **WHY MIGRATION 2 MOVED UP** above. Keep it short.
- [ ] Steps 1–6 with read-backs. Then on s2 (fresh session ids, the 9b recipe): book "Ben and Joy" on a
      Default-Tenant job → `visit_participants` has 2 rows for ONE visit, one `booked` event with both
      refs; move it → both participant copies moved, `previousTechnicianIds` on the event; s5 (ben) files a
      note → `completed`, stage `reported`, joy's participant row still there, NO second visit; on an
      unreported crew visit one `lifecycle-heart` tick mints ONE `overdue_visit_gap` observation with
      `context.participants` of two; `v_schedule` shows one row with `technician_refs = {ben-shelton,
      manager-joy}`.
- [ ] anon/authenticated false on `visit_participants`, `v_visit_participants`, both rebuilt views.

### Manual verification
- [ ] none — the board is being rebuilt; its keep-working checks are codified in Phase 3.

**Recorded, not built:** any-participant ask-of-record (extends `gapNames` at `planner.ts:2349` and
`listAskedNudgesForTechnicianJob` at `nudges.ts:624`); the stale-confirmed-visit rule; `proposed`
status cleanup.
