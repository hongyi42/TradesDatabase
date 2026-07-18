---
date: 2026-07-17
branch: fix-booking-promise-default
commit: 97b8dcc
topic: The two design fixes — (1) technician-optional bookings, (2) reversibility-driven confirmation policy — as the code stands today
---

## Summary

Two live-test findings from the pilot manager point at two design changes. This document maps
**only what exists today**, so a plan can be written against it.

**Fix 1 — bookings currently require a technician.** A "booking" is one row in the `assignments`
table (customer's job × technician × time window). Today every booking *must* name a technician
who is on the roster and not being offboarded. There is no way to book a visit with nobody
attached ("put it on the calendar, I'll assign someone later"), and the person doing a visit is
fused with the concept of a paid **seat** (a purchased roster slot). The live bot, told "just book
it" with no active technician on the roster, attached the only roster row it could find (an
*invited* hire, Ben) — because "invited" is in fact already bookable; the real gap is that *some*
technician is mandatory.

**Fix 2 — every state-changing tool that the manager drives is confirmed the same way, regardless
of whether the change is reversible.** Booking, moving, and cancelling a visit (all reversible —
undo is one more command) go through the *identical* two-step "stage → show preview → say yes →
commit" gate as sending an email or writing a permanent record. Meanwhile some genuinely
consequential writes (adding a person to the roster, which consumes a seat) are *not* confirmed at
all. So the current confirmation boundary is **not** drawn on reversibility. A second, related
finding: when the manager gave an explicit end time ("9 to 10am") the agent didn't pass it, the
server filled a **2-hour default**, and then the two-step gate made the manager confirm the
server's own wrong guess.

Everything below is the mechanics behind those two paragraphs.

## Entry Points

- **Booking verbs (no AI):** [src/schedule/booking.ts](../../../src/schedule/booking.ts) —
  `bookVisit` / `moveVisit` / `cancelVisit` and their `preview*` twins.
- **MCP tool surface (the agent's hands):** [src/mcp/server.ts](../../../src/mcp/server.ts) —
  tool declarations at lines 158–620; dispatch handlers in the `switch (name)` starting
  [server.ts:864](../../../src/mcp/server.ts#L864). Scheduling handlers:
  `book_visit` [2145](../../../src/mcp/server.ts#L2145), `move_visit`
  [2287](../../../src/mcp/server.ts#L2287), `cancel_visit`
  [2419](../../../src/mcp/server.ts#L2419).
- **Schema:** [supabase/migrations/20260704210155_scheduling_foundation.sql](../../../supabase/migrations/20260704210155_scheduling_foundation.sql)
  (assignments + duration default) and
  [supabase/migrations/20260702194603_technicians_and_review_items.sql](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql)
  (roster + seat cap + review_items).
- **The shared confirm machinery:** `review_items` rows via
  [src/db/reviewItems.ts](../../../src/db/reviewItems.ts).

## Key Files

| File | Role | Key exports / anchors |
|---|---|---|
| [src/schedule/booking.ts](../../../src/schedule/booking.ts) | The deterministic book/move/cancel verbs + previews; the one place every booking guard lives | `resolveBooking` (149), `resolveTechnician` (61), `bookVisit` (242), `moveVisit` (419), `cancelVisit` (517), `addMinutesClamped` (54) |
| [src/schedule/availability.ts](../../../src/schedule/availability.ts) | Day/window availability advisory (never blocks) | `isTechnicianAvailableOn` |
| [src/db/assignments.ts](../../../src/db/assignments.ts) | Typed assignment CRUD | `createAssignment` (37), `ASSIGNMENT_TRANSITIONS` (12), `rescheduleAssignment`, `updateAssignmentStatus`, `listAssignmentsForTechnician` |
| [src/db/technicians.ts](../../../src/db/technicians.ts) | Roster reads/writes; the single "inactive" definition | `getTechnician` (18), `getTechnicianById` (49), `insertTechnician` (75+), `isInactiveState` (352) |
| [src/db/jobTypeDurations.ts](../../../src/db/jobTypeDurations.ts) | Per-job-type / tenant duration fallback | `getJobDurationMinutes` (37) |
| [src/db/reviewItems.ts](../../../src/db/reviewItems.ts) | The review-item table = the confirm-token store | `ReviewItemKind` union (10–22), `upsertOpenReviewItem`, `getOpenReviewItem`, `resolveReviewItem` |
| [src/mcp/server.ts](../../../src/mcp/server.ts) | The whole tool surface + dispatch + manager gating | tool decls 158–620; `isActiveManager` (820); dispatch 864 |
| [supabase/migrations/20260704210155_scheduling_foundation.sql](../../../supabase/migrations/20260704210155_scheduling_foundation.sql) | assignments table + double-booking guard + `default_job_minutes` | technician_id NOT NULL (59), `no_confirmed_overlap` (70), `default_job_minutes` 120 (11–13) |
| [supabase/migrations/20260702194603_technicians_and_review_items.sql](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql) | roster, tier/state enums, seat cap | `technician_state` enum (5), `technician_seats` (32), `enforce_seat_cap` trigger (38–51) |
| [supabase/migrations/20260714120000_schedule_core_promise_ladder.sql](../../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql) | promise ladder + versioned event log | `promise_level` enum (17), CHECK (23), `schedule_events` (30) |

## Data Flows

### Fix 1 — how "a technician is required" is enforced (three layers, all must change together)

```
book_visit tool (server.ts:2145)
  └─ str('technicianRef') → if missing: throw 'technicianRef is required'   [server.ts:2155]  ← LAYER 1 (tool)
        └─ previewBookVisit → resolveBooking (booking.ts:149)
              └─ resolveTechnician(tenantId, ref)                            [booking.ts:148,61] ← LAYER 2 (verb)
                    • getTechnician → null?  → throw 'not found on the roster'
                    • isInactiveState(state)? → throw 'deactivated — reactivate the seat first'
              └─ createAssignment({ technicianId: r.technician.id, … })
                    └─ INSERT assignments(technician_id NOT NULL …)          [migration:59]      ← LAYER 3 (DB)
```

- **Layer 2 detail — which states are bookable *today*:** `isInactiveState`
  ([technicians.ts:352](../../../src/db/technicians.ts#L352)) returns true **only** for
  `offboarding` and `offboarded`. The five states are `invited | pending_verification | active |
  offboarding | offboarded`. So `invited`, `pending_verification`, and `active` are **already
  bookable** — the live bot booking *invited* Ben was consistent with the code. The only states
  `resolveTechnician` rejects are the two "leaving" ones. (The memory note "resolveTechnician
  rejects inactive" is precise: inactive = those two only.)
- **`move_visit` already allows an absent technicianRef** — `MoveVisitInput.technicianRef?`
  ([booking.ts:318](../../../src/schedule/booking.ts#L318)); omitted = keep the same technician
  (`getTechnicianById(old.technician_id)`). But the *old* row always had a technician, so this
  never produces an unassigned row today.
- **The double-booking guard is keyed on technician_id.** `no_confirmed_overlap`
  ([migration:70](../../../supabase/migrations/20260704210155_scheduling_foundation.sql#L70)) is
  `exclude … (technician_id with =, tstzrange(starts_at,ends_at) with &&) where status='confirmed'`.
  Postgres `=` never matches NULL, so if `technician_id` became nullable, two *unassigned* visits
  at the same time would **not** collide — which is the correct semantic (there is no technician to
  double-book), but it means the guard silently stops protecting unassigned rows.
- **Every schedule reader is technician-keyed:** `listAssignmentsForTechnician` /
  `overlappingConfirmed` ([booking.ts:97](../../../src/schedule/booking.ts#L97)),
  `availabilityWarning` ([booking.ts:73](../../../src/schedule/booking.ts#L73), needs a technician
  row), and the `get_team_schedule` / `get_schedule` MCP readers group by technician. An
  unassigned row has no technician to group under or check availability for.

### Fix 1 — the seat coupling (why "part-timer without a seat" is not expressible today)

There are **two independent "seat" notions**, and the roster is fused to one of them:

1. **`technician_seats`** (a column on `tenants`,
   [migration:32](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql#L32)) —
   how many technician-tier roster rows the tenant may have. Enforced by the `enforce_seat_cap`
   trigger ([migration:38–51](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql#L38)):
   any roster row whose `state` is **not** in (`offboarding`,`offboarded`) occupies a seat.
2. **`sandbox_pool`** (the agent/Telegram sandboxes,
   [migration 20260707000000](../../../supabase/migrations/20260707000000_telegram_binding_and_sandbox_pool.sql)) —
   the actual bot a person talks to, claimed by `bind_telegram`.

So today, to put a name on a visit you must create a `technicians` row, and that row **consumes a
`technician_seat`** the moment it exists (unless it's already offboarding/offboarded). There is
**no concept of a seat-less assignable person** — no "just a name to schedule against." A
part-timer who does jobs but owns no agent sandbox would still burn a `technician_seat`.

### Fix 2 — the one confirmation mechanism (uniform stage→confirm)

Eight tools share **one** two-step gate. It is not bespoke per tool — it's `review_items` rows used
as confirm tokens:

```
FIRST call (no confirmId):
  run the *_preview (all dry checks, defaults resolved)   ── writes NOTHING
  upsertOpenReviewItem({ kind: 'pending_*', subjectRef, detail:{…resolved args…, stagedAt} })
  return { status:'needs_confirmation', confirmId: item.id, preview, note:'show the manager…' }

SECOND call (confirmId only):
  getOpenReviewItem(confirmId, tenant, {kind, subjectRef})   ── forged/other-person/consumed → null
  stagedAt older than 15 min?  → dismiss + 'confirmation expired'
  resolveReviewItem(...'resolved')  ── CONSUME-FIRST (at-most-once); racing 2nd call → 'already confirmed'
  run the real verb with the STAGED args (fresh args ignored — preview == commit)
```

Concrete anchors: `book_visit` stage/confirm
[server.ts:2148–2285](../../../src/mcp/server.ts#L2148); `move_visit`
[2290–2417](../../../src/mcp/server.ts#L2290); `cancel_visit`
[2422–2504](../../../src/mcp/server.ts#L2422). The 15-minute expiry and consume-first idiom are
identical across all three.

**The tool surface, split by how it treats mutation today** (25 tools total; manager-gate =
`caller.tier==='manager' && caller.state==='active'`, [server.ts:849–853](../../../src/mcp/server.ts#L849)):

| Confirmation today | Tools | Reversible? |
|---|---|---|
| **Stage → confirm** (`pending_*` review item) | `record_field_note`, `send_email`, `retract_capture`, `record_standing_fact`, `deactivate_technician_seat`, **`book_visit`**, **`move_visit`**, **`cancel_visit`** | send/record/retract/deactivate = **no**; book/move/cancel = **yes** |
| **Direct write, no confirm** | `add_technician_seat` (consumes a seat), `reactivate_technician_seat`, `get_connect_link`, `bind_telegram` | roster mutations — **no** |
| **Read-only, no confirm** | `find_customer`, `get_customer_context`, `get_job`, `list_recent_captures`, `brief_customer`, `answer_customer_question`, `get_schedule`, `get_team_schedule`, `list_team`, `list_pending_reviews`, `web_search`, `read_webpage` | n/a |

The row that matters for the design: **`book_visit`/`move_visit`/`cancel_visit` (reversible) are
confirmed, while `add_technician_seat` (irreversibly consumes a seat, mints a permanent ref) is
not.** The boundary today is historical, not reversibility-based.

### Fix 2 — the 2-hour default and how it produced a confirmation of a wrong guess

- `default_job_minutes` defaults to **120** on every tenant
  ([migration:11–13](../../../supabase/migrations/20260704210155_scheduling_foundation.sql#L11)).
- `getJobDurationMinutes(tenantId, jobType)`
  ([jobTypeDurations.ts:37](../../../src/db/jobTypeDurations.ts#L37)) returns the tenant's
  per-job-type row if one exists, else `default_job_minutes`.
- In `resolveBooking` the end time is `input.endTime ?? addMinutesClamped(startTime,
  getJobDurationMinutes(...))` ([booking.ts:166–172](../../../src/schedule/booking.ts#L166)). So
  the default **only fires when `endTime` is omitted.**
- Live trap: the manager said "9 to 10am"; the agent called `book_visit` **without** `endTime`;
  the server filled 10:00 + 120 min → 11:00 into the *staged preview*; the two-step gate then
  showed that preview and asked the manager to confirm — i.e. **the manager was asked to confirm a
  default the server chose, not anything the manager said.** The default itself is the intended
  convenience (book without stating a length); the friction is (a) the agent not passing the
  explicit end time, and (b) confirmation firing on a machine-chosen default.

### Fix 2 — the promise ladder (a signal that exists but does not yet gate confirmation)

- `promise_level` enum `none | day | time` + `promised_day` + CHECK `promise_level='none' OR
  promised_day IS NOT NULL`
  ([migration 20260714120000:17–24](../../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql#L17)).
- `resolveMove` computes `promiseBroken`
  ([booking.ts:362–369](../../../src/schedule/booking.ts#L362)): a `day` promise breaks when the
  day changes; a `time` promise also breaks when the start time changes.
- **`promiseBroken` currently only decorates the preview/return note text**
  ([server.ts:2339, 2413](../../../src/mcp/server.ts#L2339)). It does **not** change *whether*
  confirmation happens — book/move/cancel always run the two-step gate regardless of
  `promise_level`. (This is exactly the lever the pending confirmation-doctrine refinement in
  [[agent-confirmation-ux-tone]] would repurpose.)

## External Dependencies

None new to these two areas. The surrounding surface touches Supabase (Postgres via the typed
`src/db/` layer), Composio (only via `deactivate`/`reactivate` pairing enable/disable — not the
booking path), and Telegram (`bind_telegram`, sandbox_pool). The booking verbs themselves are pure
DB + deterministic time math, no third-party calls.

## Constraints and Invariants

- **preview == commit** ([booking.ts:1–6](../../../src/schedule/booking.ts#L1)): the staged copy
  carries fully-resolved args (defaults applied) and commit runs *those*, never fresh args. Any
  confirmation redesign must preserve this or explicitly retire it.
- **assignments times are immutable per row** — a reschedule is cancel + insert
  ([assignments.ts:9–17](../../../src/db/assignments.ts#L9)), not an edit. `moveVisit` cancels the
  old row first, so a failed re-insert **strands the visit UNSCHEDULED**
  ([booking.ts:436–462](../../../src/schedule/booking.ts#L436)).
- **`no_confirmed_overlap` is the authority; the JS pre-check is advisory** — races fall through to
  the DB exclusion constraint ([booking.ts:94–105, 278–291](../../../src/schedule/booking.ts#L94)).
- **`isInactiveState` is the single definition of "no longer participates"**
  ([technicians.ts:348–354](../../../src/db/technicians.ts#L348)) — the seat-cap trigger, the
  dispatch gate, and `resolveTechnician` all consult it, so changing "who is bookable" and "who
  occupies a seat" are coupled through this one predicate + the trigger's occupancy set.
- **The manager tier gate is by tool NAME** (`ADMIN_TOOL_NAMES`,
  [server.ts:852](../../../src/mcp/server.ts#L852)); all book/move/cancel are "manager only" today.
- **`raw_captures` / `schedule_events` are append-only** (DB trigger). The confirmation redesign
  touches `review_items` (mutable) and `assignments` (status-mutable), not the append-only logs.
- **Naive-local time storage** — firm wall-clock written as-if-UTC
  ([migration 20260714120000:11–15](../../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql#L11)).

## Decision Points

Stated as forks only — no recommendation.

1. **How to represent an unassigned booking.**
   - *Nullable `technician_id`:* `ALTER … DROP NOT NULL`. Cheapest schema change, but ripples into
     the double-booking guard (NULLs stop colliding — [see Data Flows](#fix-1--how-a-technician-is-required-is-enforced-three-layers-all-must-change-together)),
     every technician-keyed reader (`get_team_schedule` grouping, availability), and `moveVisit`
     (target technician resolution).
   - *Sentinel "unassigned" roster row per tenant:* keeps `technician_id` NOT NULL and all readers
     working, but needs a special row that is exempt from the seat cap and from availability/badge
     logic, and readers must render it as "unassigned."

2. **Which technician states are bookable.** Today: everything except `offboarding`/`offboarded`
   (so `invited`/`pending_verification` already work). Fork: leave the two "leaving" states
   rejected, or allow booking against them too. This is a one-line change at `resolveTechnician`
   ([booking.ts:64](../../../src/schedule/booking.ts#L64)) but it's coupled to `isInactiveState`,
   which also drives the seat cap and the dispatch gate.

3. **Seat-less assignable person (the part-timer).** Today a roster row = a `technician_seat`
   consumer. Forks: (a) let part-timers occupy a `technician_seat` like anyone else (no code
   change, just a billing/product stance); (b) introduce a seat-exempt "schedulable person"
   concept distinct from a seated/agent-bearing technician (new column or new table + seat-cap
   trigger carve-out + reader changes).

4. **What "confirm only irreversible things" does to the schedule ops.** The three schedule tools
   share the same stage→confirm code as send/record. Forks:
   - *Make book/move/cancel one-shot* — delete the `pending_booking`/`pending_visit_move`/
     `pending_visit_cancel` two-step branches, return the result directly (undo = another command).
   - *Gate the two-step on `promise_level`* — act silently when `promise_level='none'`, keep
     stage→confirm when a customer was promised a day/time (uses the already-computed
     `promiseBroken` / `promiseLevel`, currently only text).
   - *Keep the preview, drop only the sub-questions* — still show what will happen, but never
     ask the manager to confirm a server-chosen default (the 2-hour case).

5. **Whether the 2-hour default should ever reach a confirmation.** The default lives in
   `resolveBooking` and is intended for the no-length-given case. Forks: (a) keep the default,
   stop confirming it (apply-and-state); (b) push the agent to always pass an explicit `endTime`
   when the manager states one (prompt/AGENTS.md change, not code); (c) both.

## Open Questions

- **Is there any user-facing "undo" today?** The reversibility argument assumes undo is cheap.
  `cancel_visit` and `move_visit` exist, but there is no single "undo my last booking" tool — undo
  is "cancel/move the row you just created," which requires the manager to have the assignmentId.
  Whether that is "cheap enough" to justify dropping confirmation is a product judgment, not
  readable from code.
- **What does the live agent's AGENTS.md instruct for the two-step?** The on-box s2/s3 AGENTS.md
  were hand-edited 2026-07-15 to name the scheduling verbs in the staged-tools list, but the
  bootstrap template sync (rejected PR #44) was not merged — so a rebuild could regress the live
  edit ([[agent-confirmation-ux-tone]] drift note). Any confirmation-policy change must land in
  both the server code and the agent instructions, and the template/live drift is unresolved.
- **How do `get_team_schedule` / `get_schedule` render a null-technician row?** Not traced here
  beyond "they group by technician"; the exact grouping code should be read before choosing
  Decision Point 1's option.
- **Does `move_visit`'s promise-carry logic behave when moving an unassigned → assigned row (or
  vice-versa)?** `resolveMove` assumes `old.technician_id` exists
  ([booking.ts:348–349](../../../src/schedule/booking.ts#L348)); untested against a null.
