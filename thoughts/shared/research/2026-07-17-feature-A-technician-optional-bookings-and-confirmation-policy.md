---
date: 2026-07-17
branch: fix-booking-promise-default
commit: 97b8dcc
topic: "Feature A (FOUNDATION) — (1) technician-optional bookings, (2) reversibility-driven confirmation policy — the two pilot-driven fixes, as the code stands today"
---

## Summary

Two live-test findings from the pilot manager point at two design changes. A **booking** is one row in
the `assignments` table (a customer's job × a technician × a naive-local time window). This document maps
**only what exists today** — every enforcement layer, every ripple surface, and every coupling — so a
plan can be written against it. This is the FOUNDATION the concurrent feature builds on, so the
seams matter as much as the fixes.

**Fix 1 — bookings currently require a technician on the roster.** Three independent layers enforce
"some technician is mandatory": the MCP tool (throws if `technicianRef` is absent), the deterministic
verb (`resolveTechnician` throws if the ref is unknown or being off-boarded), and the database
(`assignments.technician_id` is `NOT NULL` with a foreign key). There is no way to book a visit with
nobody attached ("put it on the calendar, assign later"), and the person doing a visit is fused to a
paid **seat** (a purchased roster slot). When the live bot was told "just book it" with no *active*
technician, it attached the only bookable roster row it could find — an *invited* hire (Ben) — because
`invited` is in fact already bookable. The real gap is not "invited was wrong"; it is that *any*
technician is required at all.

**Fix 2 — every manager-driven state change is confirmed the same way, regardless of reversibility.**
Booking, moving, and cancelling a visit (all reversible — the undo is another command) go through the
*identical* two-step "stage → show preview → say yes → commit" gate as sending an email or writing a
permanent record. Meanwhile a genuinely irreversible write — `add_technician_seat`, which consumes a
seat and mints a **permanent, never-reused ref** — has **no confirmation at all**. So the current
confirmation boundary is drawn on history, not on reversibility. A second, related finding: when the
manager gave an explicit end time ("9 to 10am") the agent omitted it, the server filled its **2-hour
default**, and the two-step gate then asked the manager to confirm the *server's own guess*.

Everything below is the mechanics behind those two paragraphs, verified line-by-line against the tree at
commit `97b8dcc`.

## Entry Points

- **Booking verbs (deterministic, no AI, no MCP):**
  [src/schedule/booking.ts](../../../src/schedule/booking.ts) — `bookVisit` / `moveVisit` / `cancelVisit`
  and their `preview*` twins. Every guard for every surface lives here (preview == commit).
- **MCP tool surface (the agent's hands):** [src/mcp/server.ts](../../../src/mcp/server.ts) — base tool
  declarations at 158–414, admin (manager-only) declarations at 419–616; the `switch (name)` dispatch
  starts at [server.ts:864](../../../src/mcp/server.ts#L864). Scheduling handlers: `get_team_schedule`
  [2063](../../../src/mcp/server.ts#L2063), `book_visit` [2145](../../../src/mcp/server.ts#L2145),
  `move_visit` [2287](../../../src/mcp/server.ts#L2287), `cancel_visit`
  [2419](../../../src/mcp/server.ts#L2419); the seat handlers `add_technician_seat`
  [2508](../../../src/mcp/server.ts#L2508), `deactivate_technician_seat`
  [2540](../../../src/mcp/server.ts#L2540), `reactivate_technician_seat`
  [2661](../../../src/mcp/server.ts#L2661); `get_schedule` (per-technician) at
  [1227](../../../src/mcp/server.ts#L1227).
- **Schema:**
  [supabase/migrations/20260704210155_scheduling_foundation.sql](../../../supabase/migrations/20260704210155_scheduling_foundation.sql)
  (assignments table + `technician_id NOT NULL` + double-booking guard + `default_job_minutes`),
  [supabase/migrations/20260702194603_technicians_and_review_items.sql](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql)
  (roster + tier/state enums + seat cap trigger + review_items), and
  [supabase/migrations/20260714120000_schedule_core_promise_ladder.sql](../../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql)
  (promise ladder + versioned event log).
- **Shared confirm machinery:** `review_items` rows used as confirm tokens, via
  [src/db/reviewItems.ts](../../../src/db/reviewItems.ts).
- **Agent instructions (must move with any Fix-2 code change):** the AGENTS.md `§0c` block written by
  [Box_Setup_Stuff/bootstrap-box.sh:541–574](../../../Box_Setup_Stuff/bootstrap-box.sh#L541).

## Key Files

| File | Role | Key exports / anchors |
|---|---|---|
| [src/schedule/booking.ts](../../../src/schedule/booking.ts) | The deterministic book/move/cancel verbs + previews; the one place every booking guard lives | `resolveTechnician` (61), `availabilityWarning` (73), `overlappingConfirmed` (97), `resolveBooking` (143), `addMinutesClamped` (54), `bookVisit` (242), `resolveMove` (335), `moveVisit` (419), `cancelVisit` (517), `naiveLocalISO` (43) |
| [src/schedule/availability.ts](../../../src/schedule/availability.ts) | Pure day-level availability advisory (never blocks) | `isTechnicianAvailableOn` (38) — `null` pattern = not schedulable (fail closed) |
| [src/routes/daySource.ts](../../../src/routes/daySource.ts) | Per-technician day-stops reader behind `get_schedule` | `listDayStops` (41) — starts from a technicianRef, so an unassigned row is structurally invisible here |
| [src/db/assignments.ts](../../../src/db/assignments.ts) | Typed assignment CRUD + the reschedule primitive | `ASSIGNMENT_TRANSITIONS` (12), `createAssignment` (37), `updateAssignmentStatus` (78), `isOverlapViolation` (116), `rescheduleAssignment` (141), `getAssignmentForTenant` (175), `listAssignmentsForTenant` (192), `listAssignmentsForTechnician` (212), `CreateAssignmentInput.technicianId: string` (22) |
| [src/db/technicians.ts](../../../src/db/technicians.ts) | Roster reads/writes; the single "inactive" definition | `getTechnician` (18), `getTechnicianById` (49), `insertTechnician` (76), `isInactiveState` (352), `isSeatCapError` (253); ref-reuse invariant comment (17–21) |
| [src/db/jobTypeDurations.ts](../../../src/db/jobTypeDurations.ts) | Per-job-type / tenant duration fallback | `getJobDurationMinutes` (37) → tenant `default_job_minutes` |
| [src/db/reviewItems.ts](../../../src/db/reviewItems.ts) | The `review_items` table used as the confirm-token store | `ReviewKind` union (10–22, incl. `pending_booking`/`pending_visit_move`/`pending_visit_cancel`), `upsertOpenReviewItem` (38), `getOpenReviewItem` (210), `resolveReviewItem` (264), `resolveOpenReviewItemFor` (125), `annotateResolvedReviewItem` (245) |
| [src/mcp/server.ts](../../../src/mcp/server.ts) | The whole tool surface + dispatch + manager gating | tool decls 158–616; `slugify` (621); `ADMIN_TOOL_NAMES` (630); `isActiveManager` (820); dispatch + gate (825–863); tools/list tier filter (3020–3030) |
| [src/db/database.types.ts](../../../src/db/database.types.ts) | Generated Supabase types | `assignments.technician_id: string` (Row 50 / Insert 66 / Update 82) — the type is non-nullable today; `sandbox_pool.technician_id: string \| null` (494) is a nullable-FK precedent already in the schema |
| [supabase/migrations/20260704210155_scheduling_foundation.sql](../../../supabase/migrations/20260704210155_scheduling_foundation.sql) | assignments + guard + duration default | `technician_id … not null references technicians(id)` (59), `no_confirmed_overlap` exclusion (70–72), `default_job_minutes … default 120` (11–13) |
| [supabase/migrations/20260702194603_technicians_and_review_items.sql](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql) | roster, tier/state enums, seat cap | `technician_state` enum (5–6), `technician_seats` column (32), `enforce_seat_cap` fn (38–48) + trigger (49–51), `uq_review_items_open` partial index (70) |
| [supabase/migrations/20260714120000_schedule_core_promise_ladder.sql](../../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql) | promise ladder + event log | `promise_level` enum (17), `promised_day_when_promised` CHECK (23–24), `schedule_events` (30–38) append-only (46–48) |
| [Box_Setup_Stuff/bootstrap-box.sh](../../../Box_Setup_Stuff/bootstrap-box.sh) | Host bootstrap that appends the agent's AGENTS.md blocks | `§0c` "Permanent-record writes — confirm FIRST" (541–574) — names only note/send/retract/fact, **not** the scheduling verbs |

## Data Flows

### Fix 1 — how "a technician is required" is enforced (three layers, all must change together)

```
book_visit tool (server.ts:2145, STAGE branch)
  └─ str('technicianRef') → if missing: throw 'technicianRef is required'      [server.ts:2155]   LAYER 1 (tool)
        └─ previewBookVisit → resolveBooking (booking.ts:143)
              └─ resolveTechnician(tenantId, ref)                              [booking.ts:148,61] LAYER 2 (verb)
                    • getTechnician → null?               → throw 'not found on the roster'
                    • isInactiveState(state)?             → throw 'deactivated — reactivate the seat first'
              └─ overlappingConfirmed(technician.id, …)   [booking.ts:177]   (pre-check keyed on technician.id)
              └─ availabilityWarning(technician, …)       [booking.ts:183]   (needs the technician row)
  (CONFIRM branch) bookVisit → createAssignment({ technicianId: r.technician.id, … })
        └─ INSERT assignments(technician_id NOT NULL references technicians)  [migration:59]      LAYER 3 (DB)
```

**Layer-2 detail — which states are bookable *today*.** `isInactiveState`
([technicians.ts:352–354](../../../src/db/technicians.ts#L352)) returns `true` **only** for `offboarding`
and `offboarded`. The five states are `invited | pending_verification | active | offboarding |
offboarded` ([migration:5–6](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql#L5)).
So `invited`, `pending_verification`, and `active` are **already bookable** — the live bot booking
*invited* Ben was consistent with the code. `resolveTechnician` rejects only the two "leaving" states.

**Ripples if `technician_id` becomes nullable** (the "put nobody on it" path). I traced each keyed
surface:

1. **The double-booking guard silently stops covering unassigned rows.** `no_confirmed_overlap`
   ([migration:70–72](../../../supabase/migrations/20260704210155_scheduling_foundation.sql#L70)) is an
   exclusion constraint `(technician_id with =, tstzrange(starts_at,ends_at) with &&) where status =
   'confirmed'`. Postgres `=` never matches `NULL`, so two *unassigned* confirmed visits at the same
   time would **not** collide. Semantically correct (there is no technician to double-book), but the DB
   authority that the whole booking path leans on (see Constraints) no longer protects unassigned rows.
2. **`createAssignment` input type.** `CreateAssignmentInput.technicianId: string`
   ([assignments.ts:22](../../../src/db/assignments.ts#L22)) and the insert at
   [assignments.ts:44](../../../src/db/assignments.ts#L44) both assume a string. Nullable needs
   `string | null` here and a regenerated `database.types.ts` (`technician_id: string | null`).
3. **`resolveBooking` calls `resolveTechnician` unconditionally.**
   [booking.ts:148](../../../src/schedule/booking.ts#L148) always resolves a technician before anything
   else; the overlap pre-check ([177](../../../src/schedule/booking.ts#L177)) and availability advisory
   ([183](../../../src/schedule/booking.ts#L183)) both take `technician.id` / the technician row. An
   unassigned booking would need this front-half to branch on "no ref given."
4. **`overlappingConfirmed` / `listAssignmentsForTechnician`** ([booking.ts:97](../../../src/schedule/booking.ts#L97),
   [assignments.ts:212](../../../src/db/assignments.ts#L212)) filter `.eq('technician_id', technicianId)`.
   With no technician there is no per-technician pre-check to run.
5. **`availabilityWarning`** ([booking.ts:73](../../../src/schedule/booking.ts#L73)) reads the row's
   `availability` pattern and time-off. No technician → no warning to compute.
6. **`moveVisit` target resolution assumes a non-null old technician.** `resolveMove`
   ([booking.ts:346–349](../../../src/schedule/booking.ts#L346)) does
   `getTechnicianById(old.technician_id, tenantId)` when no new ref is passed, then
   `targetTechnicianId = technician?.id ?? old.technician_id`. If `old.technician_id` were `null`,
   `getTechnicianById(null, …)` violates its `id: string` signature and the fallback keeps `null`; the
   overlap check then filters on `.eq('technician_id', null)`. Moving assigned→unassigned or
   unassigned→assigned is untested (see Open Questions).
7. **Readers group by technician — two different failure modes:**
   - **`get_team_schedule`** ([server.ts:2114](../../../src/mcp/server.ts#L2114)) does
     `techById.get(row.technician_id)` and already emits `technicianRef: technician?.ref ?? null` /
     `technicianName: … ?? null` ([2118–2119](../../../src/mcp/server.ts#L2118)). A null-technician row
     therefore *renders* (as null ref/name) but is **not labelled "unassigned"** — the manager sees a
     blank, not a deliberate "needs assigning."
   - **`get_schedule` / `listDayStops`** ([daySource.ts:41–50](../../../src/routes/daySource.ts#L41))
     starts from a `technicianRef`, resolves it to a row, and lists *that row's* assignments. An
     unassigned booking has no technicianRef to start from, so it is **structurally invisible** to every
     per-technician schedule view.

**The sentinel-row alternative** (keep `technician_id NOT NULL`, add one "unassigned" roster row per
tenant) inverts the trade-offs: all readers keep working, but the special row must be exempted from the
seat cap and from availability/badge/pairing, and every reader must render it as "unassigned." Two
concrete frictions the code forces:
- **Seat exemption is coupled to `isInactiveState`.** The seat-cap trigger counts rows whose `state NOT
  IN ('offboarding','offboarded')` ([migration:45,49–51](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql#L45)).
  A sentinel that avoids a seat by sitting in one of those two states would then be rejected by
  `resolveTechnician` (which calls `isInactiveState`) — so a carve-out in the trigger *and* in
  `resolveTechnician` is needed.
- **The overlap guard flips the other way.** With one shared sentinel `technician_id`, two unassigned
  visits at the same time would *falsely* collide (same key `=` same key). The nullable option loses the
  guard for unassigned rows; the sentinel option over-applies it.

### Fix 1 — the seat coupling (why a "part-timer without a seat" is not expressible today)

There are two independent "seat" notions and the roster is fused to one:

1. **`technician_seats`** (a column on `tenants`,
   [migration:32](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql#L32)) —
   how many technician-tier roster rows the tenant may have, enforced by `enforce_seat_cap`
   ([migration:38–51](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql#L38)):
   any roster row whose `state` is not in (`offboarding`,`offboarded`) occupies a seat of its tier.
2. **`sandbox_pool`** (the agent/Telegram sandboxes) — the actual bot a person talks to, a separate
   table with its own `technician_id: string | null` link (`database.types.ts:494`).

So today, to name someone on a visit you must create a `technicians` row, and that row consumes a
`technician_seat` the instant it exists (unless already offboarding/offboarded). There is **no seat-less
assignable-person concept** — a part-timer who does jobs but owns no agent sandbox would still burn a
seat. `add_technician_seat` ([server.ts:2508–2538](../../../src/mcp/server.ts#L2508)) is the only path to
a roster row, and it goes straight through `insertTechnician` (default tier `technician`, default state
`invited`).

### Fix 2 — the one confirmation mechanism (uniform stage → confirm, eight tools)

The confirmation is not bespoke per tool: it is `review_items` rows used as at-most-once confirm tokens.
Every staged tool runs the same shape (verified identical across book/move/cancel):

```
FIRST call (no confirmId) — STAGE:
  run the *_preview (all dry checks; defaults resolved)                 ── writes NOTHING to the schedule
  resolveOpenReviewItemFor(kind, subjectRef, 'dismissed', 'superseded') ── drop any prior stage for this person
  upsertOpenReviewItem({ kind:'pending_*', subjectRef, detail:{…RESOLVED args…, preview, stagedAt} })
  return { status:'needs_confirmation', confirmId: item.id, preview, note }

SECOND call (confirmId only) — CONFIRM:
  getOpenReviewItem(confirmId, tenant, {kind, subjectRef})    ── forged / other-person / consumed → null
  stagedAt older than 15 min?  → dismiss + 'confirmation expired'
  resolveReviewItem(… 'resolved')  ── CONSUME-FIRST (at-most-once); a racing 2nd call → 'already confirmed'
  run the real verb with the STAGED args (fresh args ignored — preview == commit)
  on verb failure: annotateResolvedReviewItem(confirmId, '… FAILED …')  ── the token is already consumed
```

Concrete anchors: `book_visit` stage [2148–2209](../../../src/mcp/server.ts#L2148) / confirm
[2211–2285](../../../src/mcp/server.ts#L2211); `move_visit`
[2290–2417](../../../src/mcp/server.ts#L2290); `cancel_visit`
[2422–2506](../../../src/mcp/server.ts#L2422). The subject key is the **caller's own ref**
(`subjectRef = identity.technicianRef`, e.g. [2146](../../../src/mcp/server.ts#L2146)), and the partial
unique index `uq_review_items_open` keeps at most one open stage per `(tenant, kind, subject)` — so a new
stage supersedes an unconfirmed one.

**The tool surface split by how it treats mutation today** (manager gate =
`caller.tier==='manager' && caller.state==='active'`, applied by tool NAME via `ADMIN_TOOL_NAMES` at
[server.ts:849–853](../../../src/mcp/server.ts#L849)):

| Confirmation today | Tools | Reversible? |
|---|---|---|
| **Stage → confirm** (`pending_*` review item) | `record_field_note`, `send_email`, `retract_capture`, `record_standing_fact`, `deactivate_technician_seat`, **`book_visit`**, **`move_visit`**, **`cancel_visit`** | send/record/retract = **no** (permanent record); deactivate = grace-period reversible; **book/move/cancel = yes** |
| **Direct write, no confirm** | **`add_technician_seat`** (consumes a seat, mints a permanent ref), `reactivate_technician_seat`, `resolve_review`, `get_connect_link`, `bind_telegram` | seat consumption is effectively **irreversible** (see below); the rest are roster/pairing mutations |
| **Read-only, no confirm** | `find_customer`, `get_customer_context`, `get_job`, `list_recent_captures`, `brief_customer`, `answer_customer_question`, `get_schedule`, `get_team_schedule`, `list_team`, `list_pending_reviews`, `web_search`, `read_webpage` | n/a |

**The asymmetry the fix targets.** `book_visit` / `move_visit` / `cancel_visit` are reversible — the undo
is another command (`cancel_visit` undoes a book; `book_visit` re-does a cancel; `move_visit` moves
back) — yet all three are confirmed. `add_technician_seat`
([server.ts:2508–2538](../../../src/mcp/server.ts#L2508)) is **not** confirmed, yet it is the least
reversible write in the set: the minted ref is `unique (tenant_id, ref)` **across all rows including
off-boarded ones**, and the comment at
[technicians.ts:17–21](../../../src/db/technicians.ts#L17) records that refs are *never reused across
humans* (L1 attribution is append-only). Deactivation frees the *seat* but the row/ref persist forever
in `offboarded`. So the boundary today is historical, not reversibility-based.

### Fix 2 — the 2-hour default and how it produced a confirmation of a wrong guess

- `default_job_minutes` defaults to **120** on every tenant
  ([migration:11–13](../../../supabase/migrations/20260704210155_scheduling_foundation.sql#L11)).
- `getJobDurationMinutes(tenantId, jobType)`
  ([jobTypeDurations.ts:37–60](../../../src/db/jobTypeDurations.ts#L37)) returns the tenant's per-type
  row if one exists, else `default_job_minutes`.
- In `resolveBooking` the end time is
  `input.endTime ?? addMinutesClamped(startTime, getJobDurationMinutes(...))`
  ([booking.ts:167–172](../../../src/schedule/booking.ts#L167)); `startTime` itself defaults to `'08:00'`
  ([166](../../../src/schedule/booking.ts#L166)). So the 2-hour fill fires **only when `endTime` is
  omitted**, and `addMinutesClamped` ([54](../../../src/schedule/booking.ts#L54)) clamps a spill past
  midnight to `23:59`.
- **Live trap.** The manager said "9 to 10am"; the agent called `book_visit` **without** `endTime`; the
  server filled `start + 120` into the *staged preview* (`preview.endTime`, stored on the stage at
  [server.ts:2195](../../../src/mcp/server.ts#L2195)); the two-step gate then showed that preview and
  asked the manager to confirm it — i.e. the manager was asked to confirm a default the *server* chose,
  not the end time the manager actually stated. The default itself is the intended convenience (book
  without stating a length); the friction is (a) the agent not passing the stated end time, and (b) the
  confirmation firing on a machine-chosen value.

### Fix 2 — the promise ladder: a lever that exists but does not yet gate confirmation

- `promise_level` enum `none | day | time`, `promised_day`, and the CHECK
  `promise_level = 'none' OR promised_day IS NOT NULL`
  ([migration 20260714120000:17–24](../../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql#L17)).
- `book_visit` now defaults `promise_level` to `'none'`
  ([booking.ts:192–197](../../../src/schedule/booking.ts#L192)) — this is exactly what commit `97b8dcc`
  (the current HEAD) changed: a fresh booking promises the customer nothing unless the manager's words
  show a promise.
- `resolveMove` computes `promiseBroken`
  ([booking.ts:362–369](../../../src/schedule/booking.ts#L362)): a `day` promise breaks when the day
  changes; a `time` promise also breaks when the start time changes.
- **`promiseBroken` / `promiseLevel` currently only decorate the preview/return note text**
  ([server.ts:2339–2341](../../../src/mcp/server.ts#L2339),
  [2413–2415](../../../src/mcp/server.ts#L2413)). They do **not** change *whether* confirmation happens —
  book/move/cancel always run the two-step gate regardless of `promise_level`. This is the signal a
  reversibility- or promise-gated confirmation policy would repurpose.

### The manager-driven scheduling path, end to end (agent → server → DB)

```
Telegram (manager)                       MCP server (server.ts)                     DB (typed src/db/)
   │  "book Jane for the Smiths Tue"        │                                          │
   ├───────── book_visit(stage) ──────────► │ requireManager (ADMIN_TOOL_NAMES gate)   │
   │                                        │ previewBookVisit → resolveBooking ───────► getTechnician / getCustomer / getJob
   │                                        │   (resolveTechnician, overlap pre-check, availabilityWarning) reads only
   │ ◄──── needs_confirmation + confirmId ──┤ upsertOpenReviewItem('pending_booking')  ─► review_items INSERT
   │  (agent shows preview, waits for yes)  │                                          │
   ├───────── book_visit(confirmId) ──────► │ getOpenReviewItem → 15-min → consume ────► review_items UPDATE (resolve)
   │                                        │ bookVisit(staged args) ──────────────────► createJob? + createAssignment(confirmed)
   │ ◄──────────── status: booked ──────────┤                                          ─► schedule_events INSERT ('booked')
```

## External Dependencies

None new to these two areas. The surrounding surface touches **Supabase** (Postgres through the typed
`src/db/` layer only — CLAUDE.md forbids hand-written queries elsewhere), **Composio** (only via the
deactivate/reactivate pairing enable/disable, not the booking path), and **Telegram / `sandbox_pool`**
(`bind_telegram`). The booking verbs themselves are pure DB + deterministic time math with no
third-party calls. `get_schedule` additionally calls a Google Maps route optimizer
([server.ts:1262](../../../src/mcp/server.ts#L1262)), but that path is per-technician and read-only.

## Constraints and Invariants

- **preview == commit** (house rule, [booking.ts:1–6](../../../src/schedule/booking.ts#L1)). The staged
  `review_items.detail` carries fully-resolved args (defaults applied) and the confirm branch runs
  *those*, never fresh args ([server.ts:2186–2199, 2249–2259](../../../src/mcp/server.ts#L2186)). Any
  confirmation redesign must preserve this or explicitly retire it.
- **assignments times are immutable per row** — a reschedule is cancel + insert, not an edit
  ([assignments.ts:9–17](../../../src/db/assignments.ts#L9), `ASSIGNMENT_TRANSITIONS`). `moveVisit`
  cancels the old row FIRST ([rescheduleAssignment: assignments.ts:158–169](../../../src/db/assignments.ts#L158)),
  so a failed re-insert **strands the visit UNSCHEDULED**
  ([booking.ts:436–462](../../../src/schedule/booking.ts#L436)). A move is therefore *not* atomically
  reversible — relevant to any "these ops are reversible so drop the confirm" argument.
- **`no_confirmed_overlap` is the authority; the JS pre-check is advisory** — races fall through to the
  DB exclusion constraint, which `bookVisit`/`moveVisit` catch via `isOverlapViolation`
  ([booking.ts:278–289, 442](../../../src/schedule/booking.ts#L278)). The guard is keyed on
  `technician_id` (see Fix 1 ripple #1).
- **`isInactiveState` is the single definition of "no longer participates"**
  ([technicians.ts:352–354](../../../src/db/technicians.ts#L352)). The seat-cap trigger, the dispatch
  deactivated-badge gate ([server.ts:843](../../../src/mcp/server.ts#L843)), and `resolveTechnician` all
  consult it, so "who is bookable" and "who occupies a seat" are coupled through this one predicate + the
  trigger's occupancy set.
- **The manager tier gate is by tool NAME** (`ADMIN_TOOL_NAMES`,
  [server.ts:630, 852](../../../src/mcp/server.ts#L630)); the tools/list filter is cosmetic and dispatch
  re-gates every call ([3020–3030](../../../src/mcp/server.ts#L3020)). `book_visit`, `move_visit`,
  `cancel_visit`, `get_team_schedule`, and the seat tools are all admin-only; `get_schedule`
  (self-schedule) is **not** admin.
- **Refs are unique across ALL rows and never reused across humans**
  ([migration:21](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql#L21),
  [technicians.ts:17–21](../../../src/db/technicians.ts#L17)) — the property that makes
  `add_technician_seat` effectively irreversible.
- **`raw_captures` and `schedule_events` are append-only** (DB triggers,
  [promise-ladder migration:46–48](../../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql#L46)).
  The confirmation redesign touches `review_items` (mutable) and `assignments` (status-mutable), not the
  append-only logs.
- **Naive-local time storage** — firm wall-clock written as-if-UTC; UTC-day readers stay correct;
  availability interprets timestamps with timezone `'UTC'`
  ([booking.ts:8–11](../../../src/schedule/booking.ts#L8),
  [promise-ladder migration:11–15](../../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql#L11)).
- **The confirm token is subject-keyed to the caller** (`subjectRef = identity.technicianRef`), and only
  one open stage per kind can exist per person (partial unique index) — a second stage supersedes the
  first. A confirmation-policy change that stops staging some ops must not leave a live token behind for
  those ops.

## Decision Points

Stated as forks only — no recommendation.

1. **How to represent an unassigned booking.**
   - *Nullable `technician_id`* (`ALTER … DROP NOT NULL` + regenerate `database.types.ts`): cheapest
     schema change, but ripples into the double-booking guard (NULLs stop colliding — Fix-1 ripple #1),
     `createAssignment`'s input type, `resolveBooking`'s unconditional `resolveTechnician`, every
     technician-keyed reader (`get_team_schedule` shows a blank; `get_schedule`/`listDayStops` never
     surfaces the row at all), and `moveVisit` target resolution (`getTechnicianById(null)`). A nullable
     FK precedent already exists in the schema (`sandbox_pool.technician_id`).
   - *Sentinel "unassigned" roster row per tenant*: keeps `technician_id NOT NULL` and all readers
     working, but needs a row exempt from the seat cap (coupled to `isInactiveState` + the trigger) and
     from availability/badge/pairing, readers must render it as "unassigned," and the overlap guard would
     then *falsely* collide two unassigned visits sharing the sentinel key.

2. **Which technician states are bookable.** Today: everything except `offboarding`/`offboarded` (so
   `invited`/`pending_verification` already work). Fork: leave the two "leaving" states rejected, or
   allow booking against them too. A one-line change at `resolveTechnician`
   ([booking.ts:64](../../../src/schedule/booking.ts#L64)), but coupled to `isInactiveState`, which also
   drives the seat cap and the dispatch deactivated-badge gate.

3. **Seat-less assignable person (the part-timer).** Today a roster row = a `technician_seat` consumer.
   Forks: (a) let part-timers occupy a `technician_seat` like anyone else (no code change — a
   billing/product stance); (b) introduce a seat-exempt "schedulable person" distinct from a
   seated/agent-bearing technician (new column or table + seat-cap trigger carve-out + reader changes),
   which overlaps mechanically with Decision 1's sentinel option.

4. **What "confirm only irreversible things" does to the schedule ops.** The three schedule tools share
   the same stage→confirm code as send/record. Forks:
   - *Make book/move/cancel one-shot* — delete the `pending_booking` / `pending_visit_move` /
     `pending_visit_cancel` two-step branches, return the result directly (undo = another command). Note
     the `moveVisit` non-atomicity caveat (a stranded UNSCHEDULED visit is the failure the confirm
     currently front-loads a preview for).
   - *Gate the two-step on `promise_level`* — act silently when `promise_level = 'none'`, keep
     stage→confirm when the customer was promised a day/time (reuses the already-computed
     `promiseBroken` / `promiseLevel`, currently text-only).
   - *Keep the preview, drop only the sub-questions* — still show what will happen, but never make the
     manager confirm a server-chosen default (the 2-hour case).

5. **Whether the 2-hour default should ever reach a confirmation.** The default lives in `resolveBooking`
   for the no-length-given case. Forks: (a) keep the default, stop confirming it (apply-and-state);
   (b) push the agent to always pass an explicit `endTime` when the manager states one (prompt/AGENTS.md
   change, not code); (c) both.

6. **Whether to add a confirmation to the irreversible seat-consuming write.** The mirror image of
   Decision 4: `add_technician_seat` mints a permanent ref and burns a seat with no confirm today. Forks:
   leave it unconfirmed, or give it the same stage→confirm token as the other admin mutations (a new
   `pending_seat_add` kind, mechanically identical to `pending_deactivation`).

## Open Questions

- **Is there any user-facing "undo" today?** The reversibility argument assumes undo is cheap.
  `cancel_visit` and `move_visit` exist, but there is no single "undo my last booking" tool — undo is
  "cancel/move the row you just created," which needs the manager to hold the `assignmentId`, and a
  `move`'s non-atomicity can strand a visit UNSCHEDULED. Whether that is "cheap enough" to justify
  dropping confirmation is a product judgment, not readable from code.
- **What does the live agent's AGENTS.md instruct for the two-step?** The bootstrap template's `§0c`
  block ([bootstrap-box.sh:541–574](../../../Box_Setup_Stuff/bootstrap-box.sh#L541)) names only
  `record_field_note`, `send_email`, `retract_capture`, `record_standing_fact` — the **scheduling verbs
  are absent from the template**. Per the memory notes, the on-box s2/s3 AGENTS.md were hand-edited
  2026-07-15 to name the scheduling verbs, but the template-sync PR (#44) was rejected — so a `rebuild`
  could regress the live edit. Any Fix-2 change must land in both the server code and the agent
  instructions, and the template/live drift is unresolved.
- **How do `get_team_schedule` / `get_schedule` render a null-technician row?** Traced here:
  `get_team_schedule` emits null ref/name (does not label "unassigned"); `get_schedule`/`listDayStops` is
  keyed on a technicianRef and never surfaces an unassigned row. Whether "unassigned" needs a dedicated
  bucket in these readers is a design choice Decision 1 forces.
- **Does `move_visit`'s promise-carry logic behave when moving an unassigned ↔ assigned row?**
  `resolveMove` assumes `old.technician_id` exists ([booking.ts:346–349](../../../src/schedule/booking.ts#L346))
  and `getTechnicianById` takes `id: string`; untested against a null, and moving *to* a technician (or
  *away from* one) is a new transition the code has never seen.

## Assumptions

Recorded because this is a non-interactive research pass (no user to confirm with):

- **This doc is additive to the existing research, not a replacement.** A prior doc
  (`2026-07-17-technician-optional-and-confirmation-policy.md`) covers the same area; I re-derived every
  claim against the source at `97b8dcc` rather than citing it, and this file carries `feature-A` in its
  name so the two concurrent research runs never collide. Where my reading refined the earlier doc
  (e.g. `get_team_schedule` renders null-tech rows rather than crashing; the bootstrap template provably
  omits the scheduling verbs; `sandbox_pool.technician_id` is an existing nullable-FK precedent), I state
  the verified behavior.
- **"Reversible" is used in the operational sense** the fix implies (an inverse command exists), not a
  claim of transactional atomicity — I flagged the `moveVisit` stranding case explicitly because it
  qualifies that sense.
- **The live 2-hour trap numbers** ("9 to 10am" → server-chosen end) are reproduced from the finding as a
  mechanism, not a claim about the exact stored minutes; the load-bearing fact is that
  `resolveBooking` fills `start + default` only when `endTime` is omitted and the two-step gate then
  confirms that filled value.
- I did **not** run the app, tests, seeding, or any DB write (CLAUDE.md + subagent ground rules); all
  findings are from reading source, migrations, generated types, and the bootstrap template.
