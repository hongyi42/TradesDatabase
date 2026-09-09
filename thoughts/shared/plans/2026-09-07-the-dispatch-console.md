---
date: 2026-09-07
task: The dispatch console — a wide desktop schedule surface (day/week/month grid, technician columns, drag-and-drop, right-click new job) standing BESIDE the Telegram board over the same spine, default-off, until it is good enough to replace it
research: thoughts/shared/research/2026-08-31-board-day-timeline-grid.md (found AFTER the build — see "Reconciliation"; it briefs a different change, but its open decisions overlap this one's)
status: implemented (uncommitted) — phases 1-5 done and gated; rollout to the pilot pending
supersedes: nothing
---

## Overview
The Telegram board (`web/board/`, plan 2026-07-17 Feature B-2 and its 4a/4a.5/4b successors) is a
phone-sized surface: Mon-Sun columns of day-granularity cards, one tap to a detail sheet, drag to
change the DAY. The manager's actual dispatch work — who is free at 2pm, hand this trip to someone
else, put this on the calendar at a time — wants a wide grid with a clock on it. This plan adds one:
`/console`, a second Mini App over the same spine.

**IT DOES NOT REPLACE THE BOARD, and that is the whole design.** `/board` and `web/board/` are
untouched by this work. Both UIs are live at once, over the same data, for as long as it takes; the
swap at the end is a Telegram menu-button URL and a directory deletion, with no migration to roll
back either way.

**Written retroactively.** CLAUDE.md's RPI workflow makes the plan the human-review gate, and this
build skipped it — the user asked for the change directly and the work was done first. This document
is therefore a RECORD of decisions already made and shipped into the working tree, not a proposal
that was reviewed before implementation. Read the `## Decisions` section as binding; read the
phases as history.

## Decisions
- **The console is a SECOND Mini App, not a browser app** *(user, rec. accepted)* — it is opened from
  the bot in Telegram Desktop and authenticates with the same signed initData slip, so `authBoard`
  is IMPORTED, not reimplemented. The alternative (a bot-issued deep link setting a signed session
  cookie) is what the desktop shape really implies and is the likely end state, but it is a NEW
  pre-auth attack surface on a publicly-reachable URL, and it would have to be designed and reviewed
  before a single pixel of grid existed. The API is written so that path is a later change of
  resolver only: handlers see `{tenantId, technician, tier}` and never ask how it was obtained.
- **The write verbs are DELEGATED, never copied** *(mine)* — `/console/api/{move,cancel,book,job}`
  rewrite the pathname and call `handleBoardRequest`. `handleBoardRequest` grew ONE optional
  parameter (`opts.pathname`) that changes the route it matches on and nothing else; the query string
  (`?preview=1`) still comes from the real `req.url`. Every guard — manager tier, the server-side
  past-date floor, the preview/confirm doctrine, crew replacement, the verbatim UNSCHEDULED stranding
  message — fires identically for both UIs because it IS the same branch. A second copy kept in step
  by hand is exactly how two surfaces drift, and the board's own review history is full of that
  failure. The mapping is a literal table, so an unlisted path 404s rather than falling through to
  some other board route.
- **DEFAULT-OFF, checked before any work** *(mine)* — without `CONSOLE_ENABLED` every `/console` path
  404s, page shell included. Not 401: an unauthenticated probe must not learn the route exists behind
  auth. Shipping this code is therefore not shipping the UI, which is what makes it safe to land
  half-finished and iterate against the pilot's real data.
- **The rollout lever is a PER-CHAT menu button** *(mine)* — Telegram allows one menu button per
  scope and the default scope is spoken for by "Open board". `CONSOLE_MENU_CHAT_IDS` names the
  Telegram ids that get "Open console" instead; everyone else keeps the board they have been using.
  The worker sets the default FIRST and then overrides for the named few, so a chat dropped from the
  list falls back to the board on the next restart rather than to nothing. One unreachable chat is
  logged and skipped — it must not stop the worker booting.
- **Vanilla ES modules, no build step** *(user, rec. accepted)* — matches `web/board/board.js` and
  keeps deploy at `tsc` + a static dir. A bundler + framework would buy ergonomics for a stateful
  grid and cost a new build stage, a dep tree and node_modules on the box. A ready-made calendar
  library was rejected on a sharper ground than taste: most of them do timezone math internally, and
  this codebase's rule is that stored days and times print VERBATIM.
- **`readBoardDays` gained `maxSpanDays`, an ARGUMENT — the constant stays 14** *(mine)* — the month
  grid needs 42 days (six Mon-Sun rows) and the console asks for 45. Raising the constant would
  silently widen every caller, including the technician-tier reads that share the code path. A test
  pins the board at 14 and the console at 45, so the widening cannot leak later.
- **`BoardStop` gained `jobTitle` and `priority`** *(mine)* — a wide card has room to say what the
  work is, and colour-by-priority needs the tier on the stop rather than a read per visit. Two scalar
  columns on a join the day query already makes; the board ignores them. **Both are gated on the same
  tenant re-check as `jobId`** — a stranded cross-tenant assignment discloses neither the other firm's
  words nor how urgent they called it. Pinned by the existing cross-tenant test.
- **ONE read endpoint for a whole page paint** *(mine)* — `/console/api/calendar` returns days,
  roster, tray, firm-local today, tier and self together. Three endpoints would paint the grid before
  it knew its own columns exist, and every write re-fetches all of it anyway.
- **Employee colours are DERIVED from the roster ref, not stored** *(mine)* — FNV-1a over the ref,
  quantised to 16 hue stops. A colour column would be a migration, a settings screen and a per-tenant
  conflict story for something whose only job is telling one column from another. Quantising matters:
  a near-collision is either the same stop (visibly identical, and the name disambiguates) or a full
  step away, never the "are those two different?" middle ground continuous hashing produces.
- **The console MAY mint a job; the board still may not** *(mine)* — the board refuses `customerId`
  outright because a phone-sized surface is the wrong place to open work. A right-click on a time slot
  IS the manager saying "new job, here, now". It goes through the SAME `bookVisit` verb the chat agent
  drives, so the duplicate-job mint guard, the overlap guard and the crew rules all hold, and
  `forceNewJob` is NEVER set by the server on its own: the refusal travels to the UI with its list of
  the customer's open work, the manager decides, and a second call carries the flag.
- **A new customer is created before the booking and NOT rolled back if it fails** *(mine)* — a
  customer with no work on file is an ordinary, useful record, unlike the orphaned job shell
  `bookVisit` takes care to avoid, which would sit in the scheduler queue pretending to be work.
- **`job_type` and notes are ABSENT from the new-job form** *(mine, from existing rulings)* —
  `job_type` is duration-vocabulary work and stays in chat, which is the board's stated reason and
  does not stop being true on a bigger screen. `job_notes` is planner-private by migration
  (`20260901120000`), and a manager's prose belongs in a capture with a channel
  (`manager_assistant`), not in the planner's notepad. Offering a box that silently drops text is
  worse than not offering one.
- **The tray's two row kinds stay visually distinct** *(from plan 4a's finding)* — a parked VISIT may
  already carry a crew and dropping it REPLACES that crew; an unscheduled JOB has no visit at all.
  Printing only a customer name makes them identical, and that is how a manager silently takes a real
  crew off a real trip.
- **The employee filter hides on the EXPLICIT unticked list, not on roster membership** *(mine; build
  finding)* — a technician's console is sent no roster at all, so an is-it-in-the-roster test showed
  them an empty week. It also keeps a departed roster member's remaining trips on screen instead of
  quietly dropping them. Unassigned stops are never filtered: no checkbox owns them, and hiding them
  would hide exactly the work most in need of a decision.
- **Past days are read-only, per-day** *(from the board's rule)* — the current calendar week contains
  already-past days and a live drop target on yesterday is a one-mis-drag rewrite of history. The
  client gates every drag handle and menu item on `manager && date >= firm-local today`; the server
  keeps its own floor under it.
- **Out of scope** — the browser-session auth path; a manager-authored capture from the console;
  price/line items (no schema); `job_type` editing; deleting `web/board/`; moving the default menu
  button.

- **Completed visits stay on the console grid** (user decision, 2026-09-07 evening:
  "user may refer back to their history"). `readBoardDays` gained a `statuses`
  input, default `['confirmed']`, so the Telegram board is unchanged; the console
  passes `['confirmed', 'completed']`. A done card keeps its employee colour but
  fades and desaturates (`.is-done`), carries a ✓ before the time, is not
  draggable, and its menu offers Open + Edit job only (park/cancel are refused
  server-side on a terminal row anyway). `VisitDetail` now ships `completedAt`
  and the sheet shows a "Done at" row. Never `cancelled` (own view) and never
  `proposed` (no writer mints it).

- **Undo, client-side, per tab** (user ask 2026-09-07 evening: a two-person
  visit parked by mistake had no way back but memory). Every console write is
  reversible by a write the server already accepts, so the gesture that makes
  a change records its inverse: park/move → move back with the old crew
  (`technicianRefs`) or `unassign`; booking → cancel; cancel → re-book the same
  job with the same day/time/crew (a NEW visit id — cancelled is terminal);
  job edit → edit with the previous values. Offered on the toast ("Undo"), on
  a toolbar ↶ button with the stack depth, and on Ctrl/⌘-Z outside text
  fields and dialogs. Stack of 20, memory only; reload forgets it. Before
  reversing, an entry re-reads the visit and refuses if the minute or the crew
  differ from what its write produced ("Cannot undo — moved since"). An undo
  goes through the same preview/confirm path, so undoing a booking still asks
  before cancelling. Creating a job is not undoable (no job-cancel verb on
  the board API). Cancel now reads the visit detail BEFORE the write so the
  re-book has its job id, time and crew.
- **`/console/api/untime` — the console's one write verb of its own** (user
  ask, same evening: dragging a parked visit onto the calendar had no undo).
  A placed visit goes back to "no time set": both timestamps null, crew and
  status kept (`untimeVisitRow` → `untimeVisit`, ledger event `moved` with
  `toDay: 'no time set'` so boardNotify's existing copy fires). Preview
  verdict is the cancel rule — placed → confirm — stated through
  `cancelRequiresConfirmation` so the two verbs cannot drift. Manager-only,
  same 409 triage as new-job. The board does NOT get the route: the phone
  surface has no gesture that needs it. The client's undo of "place a parked
  visit" is two writes: untime (confirmed), then `attachUnplaced` with the
  old crew if the drop changed it (not customer-visible, no second confirm).
  Verified headless: parked untimed visit (crew pn) dropped on mw's column →
  Undo → back in the tray, no date, crew pn.
- **Undo survives a "no" at its confirm.** `write()` now returns
  true / 'declined' / false; `undoLast` pushes the entry back on 'declined'
  (user report 2026-09-07: one undo "could not even" run — a dismissed popup
  had consumed it). `confirmAsk` falls back to `window.confirm` when
  `tg.showConfirm` throws (client too old, or a popup still closing). The
  preview fixture now returns a cancelled visit's job to "Not on the
  calendar" the way the server's anti-join does (the "not back in the tray"
  report was fixture-only). Headless sweep: all 14 tray jobs book → undo →
  back in the tray; decline-then-retry keeps the undo.
- **Focus comes back after a Telegram popup.** Telegram Web draws
  `showConfirm` in the PARENT window; when it closes, focus stays there, so
  the next Ctrl+Z reached Telegram, not the console, until the manager
  clicked the grid (report: "the second shortcut has no effect"). `#app` is
  focusable (`tabIndex = -1`, no outline) and `refocus()` runs after every
  popup answer and every undo. Reproduced and fixed in a cross-origin iframe
  host (scratchpad e2e `focus.cjs`): two bookings, Ctrl+Z twice in a row,
  both undone, focus in the frame after each.
- **One undo in flight at a time.** Two concurrent undos collided on the
  confirm: Telegram allows a single popup, the second `showConfirm` threw,
  the browser-confirm fallback answered "no", and the entry came back with
  "Left as it is" for a question nobody was asked; the shortcut then looked
  dead until the first popup was answered (report 2026-09-07). `undoLast` is
  serialized; a press during a run is remembered once and runs after (so
  Ctrl+Z, Ctrl+Z is still two undos); a "no" clears the queued press; key
  repeat (`e.repeat`) is dropped. Verified: two rapid Ctrl+Z → both undone,
  no collision message.
- **Undo keeps the tray row's date, time and crew — and the fixture now has
  only the two tray shapes the server can produce.** Report 2026-09-08:
  "back in the tray via undo it lost the technician / the time". On the
  server nothing is lost: a placed no-crew row's undo is a move back (date,
  time, no crew), an untimed crewed row's undo is untime + re-attach (crew).
  The preview fixture had rows with a date, no time and a crew — a shape
  rung 9a forbids — and undoing a drag of one came back dateless. Fixture
  reshaped: untimed rows in `parkedVisits`, placed no-crew rows in `visits`
  (so they also sit in the Unassigned column, as on the server), bucket
  built from both like `readLooseBucket`. Tray row shows the time on dated
  rows and carries the visit's own length as `data-span`, so a drop keeps
  it. Verified headless: dated row dragged to a technician → Undo → back at
  its old date/time, nobody on it, card back in Unassigned.
- **The confirm is the console's own dialog, not Telegram's popup** (report
  2026-09-08: "Left as it is" still appeared on quick repeated undo, by
  shortcut or button). Telegram draws `showConfirm` in the parent window,
  which gave three ways a fast repeat answered "no" for the manager: a second
  click meant for the Undo button landed on the popup's backdrop and
  dismissed it; the next keystroke went to the parent; a popup requested
  while the last was still closing was refused (`WebAppPopupOpened`) and the
  browser-confirm fallback answered "no" in the webview. `confirmAsk` is now
  an in-page `.modal-host.confirm-host`: the backdrop does NOT dismiss, only
  Go ahead / Keep it / Enter / Escape answer, Ctrl+Z is ignored while it is
  open (the keydown guard sees `.modal-host`), focus never leaves the
  document. `tg.showConfirm` is no longer used anywhere on the console.
  Verified headless: four rapid clicks on ↶ with two bookings on the stack →
  both undone (one runs, one remembered, the rest ignored), no "Left as it
  is"; the earlier suites unchanged.

- **`/console/api/canceljob` — the tray's "Delete this job"** (user ask
  2026-09-08: an open job with no visit had no way off the list but chat).
  Console-only, manager-only; calls the chat tool's core `cancelJob`
  (visits first, then the job, one ledger event each) behind the same
  preview/confirm doctrine — the preview's verdict is a literal `true`, the
  confirm names the customer and how many booked visits die with it, a
  reason is required. **No undo, on purpose:** `cancelled` is terminal in
  jobs.ts's state machine and a re-minted job is a different job with a
  different history; the confirm says so. Board URL space untouched (404).
- **Repaints keep the scroll.** `render()` reads `.rail` and `.canvas`
  scroll positions before replacing the DOM and restores them after; the
  canvas only when the paint is the same day/view/layout (`lastPaint`), so
  paging never inherits a stale offset (user report 2026-09-08: unticking a
  technician threw the tray back to the top).
- Test hardening: the past-floor test used `relDate(-1)` (UTC) against a
  firm-local floor and failed every US evening; now `relDate(-2)`.
- **Repaints keep focus; height-only viewport changes don't repaint** (user
  report 2026-09-08: on the phone the technician filter's keyboard opened
  and closed at once — the keyboard shrank the viewport, `viewportChanged`
  repainted, the input was replaced, focus died). `render()` now records the
  focused field's id and caret before replacing the DOM and restores them
  after; `resize`/`viewportChanged` go through `repaintIfShapeChanged`,
  which repaints only when the width or the tree decision changed — the CSS
  already sizes the shell off `--tg-viewport-stable-height`. Verified
  headless on the iPhone profile: type "lu", shrink height 844→500, focus
  and text kept, keep typing, roster filters; change width → repaint,
  focus and caret back.
- **Swipe turns the page; pinch sets the hour height** (user, 2026-09-08:
  "swipe between days; pinch or zoom on the grid for touch iPads"). Both
  live on the canvas, touch-only by construction (a mouse has the arrows; a
  trackpad pinch is ctrl+wheel and the browser's). One finger sideways =
  `step(±1)` — a day, a week or a month, whatever the pager is on — with
  the page following the finger and the next one sliding in; the lock is
  decided once, early (mostly vertical = the list scrolling), and a grid
  that can still scroll sideways by more than a sliver (40px; the iPad with
  the rail open clips its last column by 14px) scrolls first and turns only
  from its edge. Threshold: 80px or 20% of the width, or a quick flick.
  Two fingers on a time grid change `--pxm` (px per minute, 0.5–3, default
  1): every y in `grid.js` is now `calc(minutes * var(--pxm))`, so the
  pinch is one CSS-variable write on the `.grid` element with no repaint,
  pivoting on the hour under the fingers; `minutesAtPointer` and the drop
  hint read the same scale, and the value sticks per device
  (`localStorage` `console.pxPerMin`). CSS: `.canvas` gets
  `touch-action: pan-x pan-y; overscroll-behavior: contain` so the browser
  keeps one-finger scrolling but hands us the pinch and never turns a
  sideways overscroll into a back gesture; the list canvas is `pan-y`.
  Boot calls `disableVerticalSwipes()` so a pull at the top of the phone's
  day list scrolls instead of minimising the Mini App.
  **Bug found on the way**: `longPress` re-armed its timer on the second
  finger's `touchstart` and orphaned the first — every pinch on a column
  opened "New job" half a second later. It now cancels on any touchstart
  and arms only for a single finger. Verified headless (`touch.cjs`, CDP
  touch events): iPhone — swipe left → next day, right ×2 → the day before,
  a vertical swipe stays, a 40px drag snaps back with no inline transform
  left, month dots → next month; iPad Pro 11 (touch, no mouse, grid) —
  pinch ×2 → gutter 900→1800, card 60→120, the 12pm line stays at the same
  y, stored 2, survives a reload; pinch in ×10 → clamps at 0.5; a card at
  07:00 reads back as 07:00 at that zoom; swipe → next day, week → next
  week; at 768px (80px of sideways room) the first swipe scrolls to the
  edge and the second turns the page. Desktop suites unchanged.
- **The crew is a tick list; touch never drags** (user, 2026-09-08: "the
  move visit drop-down — we want to choose multiple technicians, same for
  put on the calendar and book"; and "long-pressed a tray row, it turned
  grey and never turned back"). `openMoveVisit`'s Who section is now a
  checkbox list of the roster (plus anyone on the visit who has left the
  roster, so they can be unticked); the current crew comes pre-ticked on
  Move…/Put on the calendar…, nobody on Book…. Untouched = `crew: null`
  (keep — a move must not overwrite a crew somebody else set meanwhile);
  none ticked = `[]` (unassigned); otherwise the ticked refs go as
  `technicianRefs`, which the console API and `bookVisit`/`moveVisit`
  already took. The grey row: `draggable="true"` on every tray row and card
  meant Android's long press started a native drag (`is-dragging`, opacity
  .4) whose `dragend` never came. Now `draggable` needs a fine pointer
  (`finePointer()`, the same media query the tree decision uses); touch gets
  the Move… form, as the tree decision already said. Two more long-press
  faults fixed on the way, both found headless: the finger lifting after a
  press synthesised a click that dismissed the menu that had just opened
  (touchend now `preventDefault`s after a fired press), and Android fires
  its own `contextmenu` on a long press as well as our 550ms timer, so two
  menus stacked (`popupMenu` closes any menu already up). Verified headless
  (`layout.cjs`, iPhone): the form pre-ticks the current crew; untick it,
  tick two others → the row is listed under both at 16:00 with
  `data-crew` = both → ↶ → back; no tray row or list row is draggable; a
  held finger (CDP) opens exactly one menu and the row keeps opacity 1;
  Book… with two people ticked → both on the card → ↶ → gone. Desktop
  drag suites unchanged (a mouse still drags).
- **The phone sheet slides** (user, 2026-09-08: "it just appears and
  disappears"). The sheet is toggled by a full repaint, so no transition
  could run. `render()` now tracks `lastPaint.sheet`: the paint that opens
  the sheet adds `sheet-enter` / `scrim-enter` (CSS animations, 260ms, only
  inside the ≤600px block); the paint that closes it has already replaced
  the DOM, so it appends an inert clone of the outgoing rail and scrim to
  the body (`ghostSheet`: ids stripped, `data-rail-close` removed,
  pointer-events none, tray scroll copied from the pre-paint `keep`) with
  `sheet-leave` / `scrim-leave` (220ms, `forwards`), removed on
  `animationend` or after 400ms. A repaint while the sheet is open (a tick
  in the roster) does not replay the slide; a width change that turns the
  sheet back into a side rail makes no ghost; `prefers-reduced-motion`
  skips both. Verified headless (`layout.cjs`, iPhone): open → rail
  animation `sheet-up`, scrim `scrim-in`; tick a technician → no replay;
  scrim tap → a `body > .rail.sheet-leave` clone with no ids, animation
  `sheet-down`, live rail hidden; clone gone within 2s.
- **Windows grow out of the centre and shrink back into it** (user,
  2026-09-08: Move, Edit job, Visit, New job, the confirm). Open is CSS
  alone: `.modal` runs `modal-in` (scale .6→1 + fade, 200ms) and the
  backdrop `scrim-in`. Close goes through one shared `retireHost(host)`
  (exported from jobModal.js, used by `closeModal`, the visit sheet and
  `confirmAsk`): it marks the host `is-closing` at once — pointer-events
  off, and the Ctrl+Z guard reads `.modal-host:not(.is-closing)` so a
  window on its way out no longer counts as open — then removes it on the
  panel's own `animationend` (`modal-out`, 150ms) or after 300ms;
  `prefers-reduced-motion` removes at once. Opening a form over a form
  (`openModal` → `closeModal`) lets the old one shrink while the new one
  grows. Verified headless (`layout.cjs`, iPhone): visit sheet open →
  `modal-in`/`scrim-in`; close → host `is-closing`, panel `modal-out`,
  pointer-events none; host gone within the wait. All other suites
  unchanged.
- **The active view button is inert; the spinner keeps its slot** (user,
  2026-09-08: pressing Day while on Day showed a spinner and nudged the
  calendar down). Two faults: the button always called `load()`, and the
  spinner was only rendered while loading, so every fetch widened the
  toolbar — on a phone that wraps it — for the length of the request. Now a
  press on the current view returns before anything runs, and the spinner
  is always in the row, `visibility: hidden` when idle, so arrows, Today
  and swipes load with the calendar exactly where it was. Verified headless
  (`layout.cjs`, iPhone): active Day pressed → 0 calendar requests, canvas
  top unchanged; arrow → canvas top identical during and after the load.
- **Phone toolbar = the date; one line of controls; colour-by below**
  (user, 2026-09-08, three rulings in a row: the screenshot "the layout is
  uneven" — the pager sat left on one line, colour-by and the view switch
  right on the next, the spinner's slot a hole after the arrows; then "all
  of them on the same line"; then "the filter on a new line below the
  others, everything else the same"). Under 600px the toolbar is: the date
  with the spinner and the fullscreen toggle at its right; tray, Today, ‹,
  ›, ↶ and Day|Month on one line, each `flex: 1 1 auto; min-width: 0` so
  the row fills a wide phone and shrinks to fit a narrow one; colour-by
  alone, full width, on the last line. Pure CSS: `.toolbar-right
  { display: contents }` frees its children, `order` places the date row
  (-2) and the select (2), `::before`/`::after` are the forced breaks.
  **Same size** (user, next): Today, ‹, ›, ↶, Day and Month are six equal
  units, 34px tall — `flex: 1 1 0` with identical padding and border,
  because flex grows CONTENT boxes and an item's padding sits on top (the
  first cut gave the segment `flex: 2` and no padding, and it came out
  20px short of two units). So on the phone the segment dissolves
  (`display: contents`) and Day and Month stand as two rounded buttons
  like the rest; the tray keeps its natural width for the badge. Verified
  headless (`layout.cjs`, iPhone): three rows, each edge to edge, the last
  the select alone; at 360px seven controls on one line, the six units
  44px wide and 34px tall each, nothing clipped; at 390px 49px each;
  screenshots at 360, 390 and 412px. **Order** (user, next): ‹ Today ›,
  then ↶, then 8px of extra room, then Day Month — CSS `order` on the
  phone row only; the desktop toolbar keeps Today ‹ › title. Verified
  headless: prev.right ≤ Today.left ≤ next.left, 12px before Day against
  a 4px row gap, units still equal (43px at 360, 48px at 390). **‹ › at
  half a unit** (user, next): `flex: 0.5 1 5px; padding: 0` — half the
  grow, and a 5px basis standing in for half of a unit's 10px of padding
  and border, so the outer width is exactly half (the shared unit rule
  excludes `[data-step]`; the first cut lost on specificity and changed
  nothing). Verified headless: units 51 / arrows 26 at 360px, 57 / 29 at
  390px, all 34px tall. **↶ on the filter's line** (user, next): order 8
  after the select, `flex: 0 0 40px` (two thirds of a unit on a 411px
  phone), 8px extra margin so 12px separate it from the select; the pager
  line is tray, ‹ Today ›, Day, Month. Verified headless: last line =
  select + undo, undo 40×34 with a 12px gap; units 65 / arrows 33 at 360,
  73 / 36 at 390. **Tighter** (user, next): ‹ › at a third of a unit
  (`flex: 0.34 1 3px`), the filter line 30px tall with 6px left padding,
  ↶ 30px to keep that line level. Verified headless: arrows 24 at 360 /
  27 at 390 against 71 / 79 units; filter and undo both 30px. **Day and
  Month at half, in place** (user, next: "shrink to half, don't move or
  resize anything else"): `flex: 0.5 1 5px; padding: 0; 11.5px`, and a
  phone-only spacer element after them (`.toolbar-fill`, `flex: 1 1
  10px`) that takes exactly the grow and the padding they gave up, so
  Today and the arrows keep their widths and the slack sits at the right
  end of the line. Verified headless: Today 70 / 78 (within 1px of
  before), Day and Month 35 / 39, slack one unit, nothing clipped at 360.
  **Then flush right** (user, next: "right-align Day and Month, only
  these two"): the spacer moves before them (order 5, the segs 6), so the
  slack sits between › and Day and Month ends at the toolbar's right
  padding. Verified headless: Month's right edge 0px from the padding,
  every other width unchanged.
- **The page turn is a strip sliding** (user, 2026-09-09: "give the swipe
  the sliding effect"). Two faults: the old day never moved, because the
  paint after `step()` replaces the DOM at once; and the new day's slide
  was cut short, because the data paint replaced the DOM again mid-slide.
  Now, on release, `ghostPage` clones the outgoing page into a fixed
  overlay on the canvas (scroll offset copied, ids stripped, inert) and
  carries it from where the finger let go to just off the edge, while the
  next paint starts the new page from the opposite edge; both 240ms,
  same easing, so they read as one strip. `render()` keeps `slideEnd`
  and `slideFrom`: a paint that lands before the slide ends, on the same
  page, restarts the transform from the interpolated position for the
  remaining time instead of snapping. Verified headless (`touch.cjs`,
  iPhone): straight after the release the old day's ghost is at −270px
  heading off, the new day at +379px heading in; both settled and the
  ghost removed within the wait. Layout and undo suites unchanged.
- **Pull to refresh** (user, 2026-09-09: "a refresh circle that comes down
  as the user pulls at the top and disappears on release — a way to
  refresh by hand and know it happened, although the page is already
  current"). A one-finger drag DOWN from `scrollTop 0` is a third lock in
  `wireTouchNav` ('pull', beside 'swipe' and 'scroll'): a ring on the body
  (`.pull-ring`, so the reload's repaint cannot remove it) follows the
  finger at half speed up to 72px, its arc turning with progress, armed
  at 56px; release when armed pins it, spins it and awaits `load()`, shown
  for at least 500ms so an instant answer still reads as a refresh, then
  retracts; release short just retracts. Never while a window is open.
  Found on the way: the fixture answers by replacing `window.fetch`, so
  Playwright's request events never see calendar calls — the earlier
  "no refetch on the active view" check was vacuous; both tests now count
  through an in-page fetch wrapper. Verified headless (`touch.cjs`,
  iPhone): a 170px pull → ring armed at full opacity → release → spinning
  → exactly one calendar call → ring gone; a 40px pull → not armed →
  retracts, no call. Layout and undo suites unchanged.
- **Touch is wired once, on the document; the arrows slide too** (user,
  2026-09-09: "sliding effect for ‹ › too"; and a headless finding while
  adding it: a swipe that began within 300ms of the last turn was lost,
  because the hit-test handed the touch to a card inside the outgoing
  page's clone, pointer-events none notwithstanding, and the clone lives
  on the body where the canvas listeners never see it). `wireTouchNav`
  now runs once at boot on `document`, resolves the canvas per touch
  (`closest('.canvas')`, or the live canvas when the touch began on a
  `.page-ghost`), and keeps its gesture state across repaints. The ‹ ›
  buttons go through `turnPage(dir)`: clone out, `slideDir`, `step` —
  the same strip as a swipe, on every tree. Verified headless: the iPad
  day swipe followed at once by a week swipe both turn; on the phone the
  › button leaves a clone at −44px heading off and the new day at +374px
  heading in. All five suites pass.

## Phases (as built)

### Phase 1 — the seam ✅
- [x] `readBoardDays` takes optional `maxSpanDays` (default 14) — `src/schedule/boardRead.ts`.
- [x] `BoardStop` carries `jobTitle` + `priority`, tenant-gated; `DAY_SELECT` embeds `title,priority`
      — `src/db/visits.ts`, `src/schedule/boardRead.ts`.
- [x] `handleBoardRequest(req, res, rawBody, opts?)`; `authBoard` and `BoardAuth` exported —
      `src/telegram/boardApi.ts`. No behavioural change for the existing caller.

### Phase 2 — the console's own surface ✅
- [x] `src/console/consoleApi.ts`: kill switch, static server (same containment posture as the
      board's), `GET /console/api/calendar`, `GET /console/api/customers`, `POST /console/api/newjob`,
      delegation table for the four shared write verbs, `GET /console/api/visit` delegated as-is.
- [x] Mounted in `src/mcp/httpServer.ts` BEFORE the IP allowlist (public-browser traffic, like the
      board) with the same 64 KiB pre-auth body cap and 413 posture.

### Phase 3 — the client ✅
- [x] `web/console/`: `index.html`, `api.js` (fetch + UTC-only date arithmetic + verbatim time
      slicing), `palette.js`, `grid.js` (day/week/month, lane packing for overlaps, crew fold),
      `jobModal.js` (new job + job edit), `app.js` (state, toolbar, rail, DnD, context menu),
      `console.css` (tokens, light + dark).
- [x] `eslint.config.js`: `web/console/**/*.js` parsed as modules, listed after the `web/**/*.js`
      script block so the board stays a script. Without it these files would have failed to parse.

### Phase 4 — reachability ✅
- [x] `setConsoleMenuButtonFor` + `consoleMenuChatIds` — `src/telegram/boardBot.ts`; called after the
      default button in `src/telegram/boardWorker.ts`.
- [x] `.env.example`: `CONSOLE_ENABLED`, `CONSOLE_STATIC_DIR`, `CONSOLE_MENU_CHAT_IDS`.

### Phase 5 — tests ✅
- [x] `src/console/consoleApi.test.ts` (20 tests) — guards the COEXISTENCE contract, not the UI: the
      kill switch really hides the surface (and does not touch the board), the console's wider range
      did not widen the board's, a delegated write is the board's write with its tier gate, the mint
      guard fires on both of its shapes and `forceNewJob` is the only way past, the past floor holds
      server-side, encoded traversal is refused.
- [x] `src/telegram/boardApi.test.ts` — the BoardStop drift guard updated deliberately (the two new
      keys, with values), and the cross-tenant test extended to assert both are withheld.
- [x] `src/telegram/boardBot.test.ts` — the chat list parses, the button is chat-scoped and points at
      `/console`, one unreachable chat does not stop the rest.

## Findings during the build
- **`form.title` is not the title input.** `HTMLFormElement` already has a `title` property (the HTML
  attribute), so named-control access silently returned a string and the job title would have posted
  as `undefined`. Every control in `jobModal.js` is reached through `form.elements`.
- **A literal `../` in a traversal test proves nothing** — the client collapses it before the request
  is sent, so the server never sees it. The test uses the encoded form, which is what a real probe
  uses.
- **The mint guard is narrower than it reads.** It fires on a TITLELESS booking or a title that names
  an open job — a genuinely new title mints without ceremony. A test written against a made-up title
  passes for the wrong reason.
- **Previews carry a verdict, not a sentence.** `requiresConfirmation` is the doctrine's output;
  there is no prompt string on the payload. The client composes the words per gesture, and a preview
  that says false is never confirmed.

## Reconciliation with the 2026-08-31 grid research
`thoughts/shared/research/2026-08-31-board-day-timeline-grid.md` was written for a DIFFERENT change:
reworking the BOARD ITSELF into a horizontal timeline (technician ROWS × hour COLUMNS) in place of
its vertical week. This plan builds a SEPARATE surface (technician COLUMNS × hour rows) and leaves
the board alone, so the two are not in conflict. But that research ends in a numbered decision brief,
and this build answered four of its six questions without knowing they had been asked. Recording the
answers, and where they diverge from its recommendation:

| Its open question | Its recommendation | What this build did |
|---|---|---|
| §7.1 Drag-and-drop | **(c)** drop drag for the rework; time-drag as a follow-up | **(b)** — drag sets the time. Diverges; see below. |
| §5.2 Roster delivery | **A** — in the day payload | A. `/console/api/calendar` returns days + roster + tray together. |
| §4 Do filters survive a day change | yes, with Reset as the way out | Yes — `hiddenRefs` persists across every load. |
| §6 Hour-axis bounds | confirm the fallback; widen or clip on outliers | Widen, never clip. **But the firm's own stored hours are ignored — a real gap, see follow-ups.** |
| §7.2 Density control | flagged, optional | Not shipped. Follow-up. |
| §9.6 Team / My schedule tabs | leave them alone | Untouched — they are the board's, and the board is untouched. |

**On diverging to (b).** Its case for (c) was that bundling a new time-setting write into a layout
rework doubles the blast radius and puts a promise-breaking gesture behind an unfamiliar UI on day
one. Both halves of that are weaker here, and one is now simply stale:
- The blast-radius argument was about REPLACING the board's render. This does not touch the board.
  The console is a separate page behind a default-off flag, reachable only by named Telegram ids, so
  "day one" is one manager on an opt-in surface with the board still one restart away.
- The cost estimate — *"a new write shape, new previews/confirmations, new promise-break paths
  through `moveVisit`"* — **has gone stale since 2026-08-31.** `moveVisit` already takes
  `date` + `startTime` + `endTime`, so the time-drag needed no new write shape and no new preview:
  it posts the verb that existed. And the promise ladder was DELETED by rung 9a — `MoveVisitPreview`
  now carries `requiresConfirmation: false` unconditionally, with the comment "always false since
  rung 9a — a move is one-shot". There are no promise-break paths left to open.
- Its §7.1 also warns that per-bar `✕`-to-unschedule and per-row `✕`-to-hide would sit inches apart
  meaning opposite things. That collision does not arise here: hiding is a checkbox in the left rail,
  and cancelling is a named item in the card's context menu behind a required reason.

**Two of its factual claims are stale generally, worth flagging for anyone who reads it next:**
`BoardDays.days[].unplaced` no longer exists (rung 9a deleted the per-day strip; untimed visits live
in the flat tray, which is where this console renders them), and its `board.js` line numbers predate
rungs 9b/9c.

## Verification
```
npm run typecheck                                          PASS
npm run lint                                               PASS
npm run build                                              PASS
npx vitest run src/console src/telegram/boardApi.test.ts \
               src/telegram/boardBot.test.ts               75 passed, 1 failed
```
The one failure is `oversized body → 413` in `boardApi.test.ts` — `ECONNRESET` from undici on
Windows. **Pre-existing**: confirmed by stashing this work and running that test alone on clean
`main`, where it fails identically.

**Full `npm test` does not pass on this machine for an unrelated, pre-existing reason**: the local
Supabase stack is missing migration `20260908100000` (rung 10 — `job_captures`,
`observations.pinged_at/asked_at`), which accounts for ~72 failures. `supabase migration up --local`
refuses because the local DB records `20260907110000`, a version with no file in the repo. The fix,
which touches only a developer's own stack:
```
npx supabase migration repair --status reverted 20260907110000
npx supabase migration up --local
```

## Follow-ups this build leaves open
- **The hour axis ignores the firm's stated work hours.** `tenant_settings.approx_work_start_hour` /
  `approx_work_end_hour` exist and are deliberately un-defaulted (`tenantSettings.ts:111-124` even
  refuses an inverted pair). The console hardcodes a 06:00-21:00 band and widens it to contain
  outliers. Correct fallback, wrong first choice: a firm that starts at 07:00 and stops at 17:00
  should see its own day, not ours. Cheap fix — the calendar payload already fetches the tenant.
- **No density control** (§7.2) — one fixed 60px hour. A compact/comfortable toggle is the minimum
  viable version if a manager wants a whole day on screen at once.
- **A manager-authored note has nowhere to go.** The new-job form deliberately has no notes box; the
  right home is a `raw_captures` row on channel `manager_assistant`, which does not exist as a write
  path from any UI yet.
- **The browser-session auth path** — the console is Telegram-only today. The API is shaped so this
  is a change of resolver, not of contract.
- **No DOM tests.** `consoleApi.test.ts` covers the server surface; the client is verified by hand,
  which is the board's situation too (research §8 says the same about `board.js`).

- **Untimed completed visits (walk-ins) are still invisible on the grid.** A
  trip born `completed` from a field note has no `starts_at`, only
  `completed_at`, so the day/week/month reads (keyed on start) cannot place it.
  Drawing it at `completed_at` means inventing a span; showing it as a marker
  needs a second read. Decide once someone asks where a walk-in went.

- **Responsive routing — decided and BUILT 2026-09-08 (first cut).**
  `layout()` in app.js; `web/console/list.js` is the small tree (day list
  grouped by technician, trips counted not people; month = 7-column dots,
  tap → that day); `openMoveVisit` in jobModal.js is the Move… / Book… form
  (date, start, end, one person or nobody, "keep as is" on a move), offered
  in every card menu and both tray menus, so touch has a full route onto the
  grid; `+ New job` button on the phone day (no right-click on empty space).
  Undo entries are shared with the drag paths (`moveVisitTo`). Verified
  headless (`layout.cjs`): 420px + mouse → grid; 390px + mouse → grid (the
  veto); iPhone 13 → list, no Week, rows not draggable; tap → sheet; Move…
  form → row on another technician at 16:00 → ↶ → back; Book… from the tray
  → on the list → ↶ → gone; month dots → tap → that day. Desktop suites
  unchanged. Since built: swipe day-to-day and pinch on the grid (decision
  above). Not yet: a technician's own phone view of the console (they keep
  the board); a way to reset or set the hour height without a touch screen
  (a density toggle for the mouse).
  **Phone tray = bottom sheet** (user, 2026-09-08): under 600px the rail is
  `position: fixed; bottom: 0`, 62vh max, handle bar, scrim over the day;
  ≡ or the scrim closes it; a row placed or booked from the sheet closes it
  so the repaint shows the result. Verified headless (position fixed,
  flush with the bottom, scrim present); desktop suites unchanged.
  The design as decided:
  `layout()` computed inside every `render()` (the `railVisible()` pattern,
  same resize / viewportChanged / fullscreenChanged listeners), never once
  at boot — the Mini App measures its own iframe, and Telegram Web opens it
  at ~420px inside a 1900px window. Classifier: width decides, two vetoes
  can only say "big":
  `big = ['tdesktop','macos'].includes(tg.platform) || matchMedia('(hover: hover) and (pointer: fine)').matches || innerWidth >= 768`.
  Big → the grid (existing 900/600 media queries stay inside it); small →
  a day list grouped by technician (the board's list, so cutover can delete
  `web/board/`), tap → sheet, long-press → menu, month → 7-column dots, no
  week. Menu-driven "Move…" (date + time picker) must exist in BOTH trees:
  HTML5 drag never fires on touch, so a big touch iPad has the grid but not
  the drag. State (`anchor`, `view`, filters, undo stack) stays above the
  branch so crossing 768 keeps it. Test: the headless harness at 390×844
  `hasTouch` asserts the list, at 420 wide with `hover:hover` asserts the
  grid. Separate routes rejected (double maintenance, resize = navigation).

## Rollout (not yet done)
- [ ] Set `CONSOLE_ENABLED=1` on the Render web service.
- [ ] Set `CONSOLE_MENU_CHAT_IDS` to the pilot manager's Telegram id; restart the board worker.
- [ ] Open it in Telegram Desktop as that manager and drive it against the pilot's real week: place a
      tray job, hand a trip to another technician, park one back, mint a job by right-click, and
      confirm the board still shows every one of those changes.
- [ ] Widen the id list as it proves out.

## Cutover (a later decision, not this plan)
Move the default menu button from `/board` to `/console` in `setBoardMenuButton`, then delete
`web/board/` and the board's page-shell routes. The API stays — `/board/api/*` is the dispatch API
that both UIs speak; renaming it is cosmetic and belongs to that change, not this one.
