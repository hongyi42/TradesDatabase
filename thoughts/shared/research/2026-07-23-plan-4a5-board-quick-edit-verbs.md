---
date: 2026-07-23
branch: feature-promise-vocab
commit: fd89d03
topic: Plan 4a.5 — board quick-edit verbs; lanes/drop targets, drag-move flow, bucket tray, assign/detach verb semantics, and the seams where all-roster lanes / assign-from-tray / drag-to-park would hook in
---

## Summary

The dispatch board is a web page that lives inside Telegram (a "Mini App" — Telegram's
embedded-browser feature). Managers see the whole team's week as per-technician *lanes* (one
column of visit cards per person per day) and can already make two quick edits by touch: drag a
visit card to another day or lane (a *move*, which can also attach a person to an unassigned
visit), and tap ✕ to cancel a visit. Every edit goes through the same server-side booking verbs
the chat agent uses, so the promise ladder (the record of what a customer was told) gates board
gestures exactly as it gates chat. This document maps how the board builds its lanes and drop
targets, the full drag-move path from finger to Telegram push notification, what the tray for
"loose" work (parked visits + unscheduled jobs) can and cannot do, and precisely which server
verbs exist — and which do not (there is **no detach verb** anywhere in the stack) — for the
upcoming quick-edit work.

## Entry Points

- [web/board/index.html](web/board/index.html) — the page shell; loads `telegram-web-app.js`
  (the one allowed external script) + `board.js`/`board.css` from `/board/static/`.
- [web/board/board.js:12](web/board/board.js#L12) — the whole client, one IIFE. Boot at
  [board.js:963-982](web/board/board.js#L963-L982) (initData guard → `wireWrites()` → `refresh()`).
- [src/telegram/boardApi.ts:150](src/telegram/boardApi.ts#L150) `handleBoardRequest` — the
  board's entire HTTP surface (static + 5 API routes), mounted by httpServer.ts BEFORE the IP
  allowlist (board traffic is public-browser traffic, self-authenticated via initData).
- [src/schedule/booking.ts](src/schedule/booking.ts) — the shared deterministic verbs
  (book/move/cancel + previews) that the board, the MCP chat tools, and the future auto-scheduler
  all call.
- [src/telegram/boardWorker.ts](src/telegram/boardWorker.ts) → [boardNotify.ts:130](src/telegram/boardNotify.ts#L130)
  `pollOnce` — turns `schedule_events` into canned Telegram pushes after any write.

## Key Files

| File | Role | Key exports / notes |
|---|---|---|
| [web/board/board.js](web/board/board.js) | The Mini App client (983 lines, vanilla JS) | `renderDay` (lane construction), `moveFlow`/`cancelFlow` (write path), `targetAt` (drop-target resolution), `openBucket`/`fetchBucket` (tray), `openDetail` (read-only sheet) |
| [web/board/board.css](web/board/board.css) | Styles | `.lane` (:119), `.lane-unassigned` (:121-122, dashed cards), `.drop-hover` (:191), `.drag-chip` (:178), bucket classes |
| [src/telegram/boardApi.ts](src/telegram/boardApi.ts) | HTTP routes + auth | `authBoard` (initData → global roster row → tenant), routes: `GET /board/api/day`, `GET /board/api/visit`, `GET /board/api/bucket`, `POST /board/api/move`, `POST /board/api/cancel` |
| [src/schedule/boardRead.ts](src/schedule/boardRead.ts) | Board read models | `readBoardDays` (day window, horizon clamp), `readLooseBucket`, `readUnscheduledJobs`, `readVisitDetail` |
| [src/schedule/booking.ts](src/schedule/booking.ts) | Shared write verbs | `bookVisit`/`previewBookVisit`, `moveVisit`/`previewMoveVisit`, `cancelVisit`/`previewCancelVisit`, `bookingRequiresConfirmation` |
| [src/db/assignments.ts](src/db/assignments.ts) | DB layer | `rescheduleAssignment` (:143 — cancel + fresh insert, **new row id**), `RescheduleInput` (:124 — `technicianId?: string`, no null) |
| [src/db/technicians.ts](src/db/technicians.ts) | Roster reads | `listTeam(tenantId)` (:130 — ALL rows incl. offboarded, ordered by ref; not exposed to the board today), `isInactiveState` (:447), `findRosterByTelegramUserIdGlobal` (:65 — board auth) |
| [src/telegram/boardNotify.ts](src/telegram/boardNotify.ts) | Push notifications | `pollOnce` — event kinds handled: `booked`, `moved` (both sides via `previousAssignmentId`), `cancelled`, `move_failed` |
| [src/telegram/rosterCache.ts](src/telegram/rosterCache.ts) | 60s auth memoization | success-only cache of the roster lookup |
| [src/mcp/server.ts](src/mcp/server.ts) | Chat-side verbs | `book_visit` (:652), `move_visit` (:692 — "also how a technician gets ATTACHED to an unassigned visit"), `cancel_visit` (:719) |

## Data Flows

### 1. Lane construction (read path)

`refresh()` → `GET /board/api/day?from=…&to=…` → `readBoardDays` returns
`{tier, self, view, from, to, days:[{date, stops:[BoardStop]}]}`. Each `BoardStop` carries
`technicianRef`/`technicianName`/`unassigned` plus times, promise fields, `locked`, `jobId`
([boardRead.ts:34-50](src/schedule/boardRead.ts#L34-L50)).

The client groups stops into lanes **from the stops alone**
([board.js:199-223](web/board/board.js#L199-L223)): a lane object is created only when a stop
with that `technicianRef` exists on that day. Consequences, as the code stands:

- A technician with no visit on a given day has **no lane on that day** — no drop target exists
  for them. Every *day* section renders (empty days included — "the drop targets that make 'move
  to Thursday' possible", [board.js:291-306](web/board/board.js#L291-L306)), so a **plain day
  drop** is always possible, but a plain day drop **keeps the current person**
  ([board.js:673-675](web/board/board.js#L673-L675)).
- The board never fetches the roster. `listTeam(tenantId)` exists in the DB layer
  ([technicians.ts:130](src/db/technicians.ts#L130)) but no board endpoint exposes it; the day
  payload's only roster knowledge is per-stop ref/name. (readBoardDays deliberately dropped its
  roster read in the latency work — [boardRead.ts:119-126](src/schedule/boardRead.ts#L119-L126)
  comment: "was: assignments + jobs-with-customer + the full roster = three serial round-trips".)
- Lanes are keyed by `technicianRef` (unique roster handle), never display name
  ([board.js:168-175](web/board/board.js#L168-L175) comment), and sorted by ref.
- The Unassigned lane renders last, `data-lane=""`, dashed cards.

### 2. Drag-move flow (end to end)

```
finger down on a .draggable card            (board.js:895-910; class = the ONE
        │                                    write-affordance truth: manager +
        │ touch: 300ms hold / mouse: 8px     Team tab + week>=0 + day>=today)
        ▼
beginDrag → chip follows pointer            (board.js:815-834; Telegram vertical
        │                                    swipes suspended for the drag)
        ▼
targetAt(x,y)                               (board.js:781-808)
        │  .lane → {date, laneRef, label}   — lane drop = assign/reassign
        │  .day  → {date, laneRef:null}     — day drop = keep person
        │  lane-unassigned → null (INERT — "moveVisit cannot detach")
        │  past day → null (INERT)
        ▼
moveFlow(card, date, laneRef, label)        (board.js:663-722)
        │  body = {assignmentId, date, startTime/endTime from card data-attrs,
        │          reason:'Moved on the dispatch board',
        │          technicianRef ONLY if laneRef differs from card's data-ref}
        │  same-day drop with no ref change → silently dropped (no-op)
        ▼
POST /board/api/move?preview=1  ──► previewMoveVisit (booking.ts:470)
        │                            requiresConfirmation = promiseBroken
        ├─ requiresConfirmation → tg.showConfirm("This breaks a promised day
        │                          (fromDay → toDay)… Move anyway?") → yes ↓ / no stop
        ▼
POST /board/api/move            ──► moveVisit (booking.ts:495)
        │                            └─ rescheduleAssignment (assignments.ts:143):
        │                               cancel old row + INSERT FRESH ROW (new id),
        │                               technicianId: input.technicianId ?? old.technician_id
        │                            └─ appendScheduleEvent kind:'moved'
        │                               {fromDay, toDay, promiseBroken, previousAssignmentId}
        ▼
toast "Moved to …" (+ promiseBroken / warning verbatim) → refresh()
        ▼  (async, ~seconds later)
boardWorker pollOnce → pushesFor('moved')   (boardNotify.ts:69-98)
        new tech ≠ old tech → two pushes ("landed on your schedule" /
        "moved off your schedule"); same tech → one; unassigned side → nobody
```

Failure paths: verb refusals (overlap clash, unknown assignment, the UNSCHEDULED stranding)
travel **verbatim** as 409 ([boardApi.ts:356-372](src/telegram/boardApi.ts#L356-L372)); the
stranding message ("the old booking was cancelled but re-booking failed … currently
UNSCHEDULED") must be shown, never masked. DB-layer faults (`/ failed: /` pattern) → logged 500.

### 3. The cancel flow

`✕` button → `cancelFlow` ([board.js:724-773](web/board/board.js#L724-L773)) — same
preview→confirm→commit shape; `requiresConfirmation = promiseLevel !== 'none'`; commit toast
discloses a promise that appeared between preview and commit.

### 4. The bucket tray (read-only today)

Pill (managers only, count filled async after paint) → tap → `openBucket`
([board.js:507-534](web/board/board.js#L507-L534)) re-fetches `GET /board/api/bucket` →
`readLooseBucket` → full-screen overlay (`#detail-overlay`) listing:

- **Parked visits** (`bucketVisitRow`, [board.js:454-469](web/board/board.js#L454-L469)) — rows
  carry `data-id`; the ONLY gesture is tap → `openDetail(assignmentId)` (read-only sheet).
- **Unscheduled jobs** (`bucketJobRow`, [board.js:471-479](web/board/board.js#L471-L479)) — rows
  carry **no data attributes and no gesture at all**.

The tray overlay covers the board (same overlay mechanism as the detail sheet), so board lanes
are not visible/reachable while it is open.

### 5. Server verb semantics (the complete assign/reassign/detach surface)

| Intent | Verb | Semantics as coded |
|---|---|---|
| Book with person | `bookVisit` + `technicianRef` | Overlap pre-check + DB guard; availability advisory (warning, never blocks) |
| Book unassigned ("park") | `bookVisit`, ref omitted | [booking.ts:170-175](src/schedule/booking.ts#L170-L175); exempt from the DB overlap guard (NULL never matches), so an identical person-less duplicate (same customer + exact window) is refused in code ([booking.ts:205-227](src/schedule/booking.ts#L205-L227)) |
| Times on book | — | `startTime` AND `endTime` REQUIRED, **no default length** (user decision 2026-07-18); the agent asks rather than the server inventing one |
| Attach person to parked visit | `moveVisit` + `technicianRef` (+ same date/time) | [booking.ts:410-418](src/schedule/booking.ts#L410-L418); this is the documented attach path (`move_visit` description, [server.ts:692](src/mcp/server.ts#L692)) |
| Reassign | `moveVisit` + `technicianRef` | Same call; promise break computed from day/time change only — a same-slot reassignment alone is never a promise break |
| Keep person on move | `moveVisit`, ref omitted | `technicianId: input.technicianId ?? old.technician_id` ([assignments.ts:164](src/db/assignments.ts#L164)) |
| Move endTime default | — | omitted endTime preserves the OLD duration (clamped to 23:59, [booking.ts:56-60](src/schedule/booking.ts#L56-L60)) — unlike book, this carries a real value forward |
| **Detach person** | **does not exist** | `RescheduleInput.technicianId?: string` accepts no null ([assignments.ts:127](src/db/assignments.ts#L127)); `?? old.technician_id` always carries the person; `move_visit`'s contract is "omit = same technician"; boardApi 400s a present-but-empty ref ([boardApi.ts:327-332](src/telegram/boardApi.ts#L327-L332)); the client makes the Unassigned lane an inert target *because* of this gap ([board.js:787-790](web/board/board.js#L787-L790)) |
| Cancel | `cancelVisit` | Status flip + event; job stays open (returns to the bucket via the anti-join) |

Notable: because a move is cancel + fresh insert, **the assignmentId changes on every move** —
the board copes by full `refresh()` after any write, and the tray re-fetches on open.

## External Dependencies

- **Telegram Mini App runtime** — `telegram-web-app.js` (initData, theme, `showConfirm`,
  `disableVerticalSwipes`, `openLink`). initData verified server-side (HMAC, `initData.ts`)
  against `BOARD_BOT_TOKEN`.
- **Supabase (PostgREST)** via the typed `src/db/` layer; the assignments overlap exclusion
  constraint is the concurrency authority (ignores NULL-technician rows).
- No other external services on this path.

## Constraints and Invariants

- **One write path**: the board's move/cancel are the SAME booking.ts verbs the chat agent
  drives — "every guard here protects every surface at once" ([booking.ts:1-6](src/schedule/booking.ts#L1-L6)).
  Confirmation doctrine single-sourced as `requiresConfirmation` on previews.
- **Write affordance gates** (client): `actionable()` = manager AND Team tab AND
  `weekOffset >= 0`; per-day `canAct` additionally requires `date >= state.today`; the
  `.draggable` class is the single affordance truth. Server re-gates: move/cancel/bucket are
  403 for non-managers.
- **Preview == commit** house rule: previews resolve defaults so the staged copy carries exactly
  what commit writes.
- **Naive-local time**: wall-clock stored as if UTC; the client prints slices verbatim and does
  zero timezone math; server computes firm-local `today`.
- **The board never sees the roster** — only refs/names riding on stops. Filtering questions
  (offboarded rows, `seat_exempt` names) are currently decided caller-side via
  `isInactiveState`; `listTeam` returns ALL rows including offboarded.
- **Unassigned rows are invisible to the DB overlap guard** — the code-level duplicate refusal
  in `resolveBooking` is the only anti-duplication for person-less rows, and it exists only on
  the *book* path (a future detach creating person-less rows would sit outside it).
- **`schedule_events` kinds are closed**: booked / moved / cancelled / move_failed (+
  completed/backfilled, no push). A reassignment notifies both sides through the `moved` kind's
  `previousAssignmentId`; an unassigned side notifies nobody ([boardNotify.ts:37-49](src/telegram/boardNotify.ts#L37-L49)).
- **14-day server cap** on the day window; the board always requests Mon–Sun (7).
- Recorded limitation (4a): `proposed`-status unassigned rows are invisible to both bucket
  halves; no production writer mints them today.
- Technician-tier reads clamp at the visibility horizon; the manager board never clamps.

## Decision Points

1. **Where all-roster lane data comes from.** The client can only render lanes for refs it
   knows. Options given the code: (a) add roster names/refs to the `/board/api/day` response
   (readBoardDays deliberately dropped its roster read for latency — it would return, or ride a
   parallel query); (b) a separate endpoint (the `bucket` pattern: async fetch, manager-gated);
   (c) keep stops-only lanes (status quo — empty lanes impossible). Any roster read must decide
   the filter: `listTeam` includes offboarded rows; `isInactiveState` + `seat_exempt` semantics
   are caller-side today.
2. **Empty lanes as drop targets.** `renderDay` renders lanes only when stops exist; `targetAt`
   resolves `.lane` ancestors. Empty-lane targets mean rendering lane divs with no cards and
   (likely) deciding how they collapse visually on 7 dense days × N technicians.
3. **Assign-from-tray for parked visits.** The tray is a full-screen overlay — board lanes are
   not drag-reachable while it is open. The verb exists (`moveVisit` + ref + the visit's own
   date/times, endTime defaulting handled). The missing piece is purely UI: a target-picker in
   the tray, or closing the tray into a drag, or something else.
4. **Scheduling unscheduled jobs from the tray.** The only server path is `bookVisit(jobId, …)`
   which REQUIRES `startTime` + `endTime` (no default length, standing user decision) — a
   drag/tap gesture has no times to inherit from anywhere. The board also has **no
   `/board/api/book` endpoint** today; move/cancel are its only writes.
5. **The detach/park verb.** Does not exist at any layer. Adding it means: widening
   `RescheduleInput` (or a new primitive) to express "set technician to NULL"; deciding the
   `move_visit`/board contract signal (today "omit = keep", empty string = 400); the duplicate
   question for person-less rows (the book-path guard doesn't cover a detach); and whether/what
   `boardNotify` pushes (the `moved` kind's two-sided logic already handles "moved off your
   schedule" for the old person; the new row's unassigned side notifies nobody).
6. **Whether board writes stay manager-only.** Every write route 403s technicians today; new
   verbs inherit that gate or deliberately open it.

## Open Questions

- Can a drag gesture practically cross from the tray overlay onto board lanes in the Telegram
  webview (overlay stacking + pointer capture), or does assign-from-tray need a non-drag UI?
  Reading alone can't answer; needs a device probe.
- Availability display for drop targets: the server computes `availabilityWarning` per move
  (advisory, toast-only today). Whether an all-roster lane surface would want that signal
  *before* the drop (per-lane, per-day) is a product/perf question — it is one query per
  technician per day as coded.
- Whether the 60s `rosterCache` staleness window matters for any new roster-lanes endpoint
  (a just-deactivated technician's lane lingering ≤60s).
