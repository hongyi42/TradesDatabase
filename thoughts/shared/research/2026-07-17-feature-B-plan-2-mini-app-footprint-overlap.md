---
date: 2026-07-17
branch: fix-booking-promise-default
commit: 97b8dcc
topic: Feature B (Plan 2 — Telegram Mini App dispatch board) — concurrent-run footprint & overlap validation against Feature A (technician-optional + confirmation policy); does Plan 1's unchecked Phase 5 block?
concurrent_feature_A: thoughts/shared/research/2026-07-17-technician-optional-and-confirmation-policy.md
prior_feature_B_survey: thoughts/shared/research/2026-07-17-plan-2-telegram-mini-app-dispatch-board.md
supersedes: nothing — sibling delta to the prior Feature B survey, focused on the parallel-vs-stacked decision
---

## Summary

This is the **footprint-and-overlap delta** for Feature B (Plan 2 of the Telegram-schedule series —
the **dispatch board**: one global, non-AI board bot on Render serving a launch button + a hosted
web page to managers and technicians, tenant isolation via a roster lookup of the verified Telegram
user id). A full code survey of Feature B already exists in the sibling doc
[2026-07-17-plan-2-telegram-mini-app-dispatch-board.md](2026-07-17-plan-2-telegram-mini-app-dispatch-board.md);
this document does **not** repeat it. Its single job is the question the concurrent-two-feature RPI
workflow asks (CLAUDE.md → "Two concurrent features — plan both first"): **can Feature B be
implemented in parallel with the other feature in flight, or must the two be stacked — and if
stacked, which lands first?**

Plain-language framing of the two features being planned in the same window (both researched today,
both off commit `97b8dcc`):

- **Feature A** — [technician-optional bookings + reversibility-driven confirmation policy](2026-07-17-technician-optional-and-confirmation-policy.md).
  It **reshapes the booking foundation**: lets a visit be booked with nobody attached, redraws the
  "which changes need a confirm" boundary around reversibility, and stops the manager confirming a
  server-chosen 2-hour default. It edits the booking verbs, the assignments schema, the roster
  layer, and the manager tool surface.
- **Feature B** — this one, the **Mini App board**. It **adds a new surface** (a browser page inside
  Telegram) that *reads* the team's days and *drives* the existing booking verbs. It is almost
  entirely greenfield new files plus one routing edit and one roster-layer read helper.

**Finding — the "STACKED, foundation-first" prediction is CONFIRMED by the actual footprints.**
The two features' file footprints are **not disjoint**, so CLAUDE.md's rule ("Disjoint → parallel;
overlapping → stack them") lands on **stack**. The overlap is asymmetric: Feature B *consumes* the
exact read shape, write/confirm model, and roster semantics that Feature A *rewrites*; Feature A
consumes nothing from Feature B. The dependency direction is therefore strictly **B → A**, which is
what "foundation-first" names: **land A, then re-check/rebase B on the result.** The one file both
features literally edit is `src/db/technicians.ts` (different functions — low textual-conflict risk);
the load-bearing overlap is at the **contract layer** (`get_team_schedule`'s return shape,
`booking.ts`'s verb semantics, the confirmation flow), where a naive git-merge would *not* conflict
yet building B in parallel against today's foundation would still force a redo of B's renderer and
write path once A lands.

**Finding — Plan 1's unchecked Phase 5 does NOT block planning or building Feature B; it gates
Feature B's own live rollout.** The prior survey listed as an open question whether Plan 1's
migration was ever applied to the pilot. A read-only check of the pilot ledger
(`mcp__supabase-test__list_migrations`, 2026-07-17) shows **`schedule_core_promise_ladder` IS applied
to the pilot** (version `20260715202139`) — so `promise_level` / `locked` / `schedule_events` exist
there and the **schema does not block**. The Phase-5 checkbox in the plan doc is simply stale. What
remains unconfirmed from Phase 5 is the **`--hosted` backfill** (whether the pilot's `assignments`
table has real rows) and the **Render web+cron redeploy** — neither blocks building/testing B on the
local stack (Plan 1 Phase 1 is checked, so the local stack has the columns), but both gate **B's live
E2E** (an empty pilot ⇒ an empty board; pre-Plan-1 Render code ⇒ nowhere coherent to attach B's board
routes). Net: finish Plan 1 Phase 5 on the pilot before B's live verification — that is the same
"foundation-first" ordering, one layer down.

## Entry Points

The seams where the parallel-vs-stacked decision is actually decided — the files each feature opens,
and where they meet:

- **Feature B's one existing-file server edit:** the routing table in
  [src/mcp/httpServer.ts:224-268](../../src/mcp/httpServer.ts#L224), specifically the MCP
  fallthrough that swallows every unrouted path
  ([httpServer.ts:253-260](../../src/mcp/httpServer.ts#L253)). Board/browser/initData routes must be
  added **before** it. Feature A does **not** touch this file → **no collision here.**
- **Feature B's one existing-file DB edit:** a tenant-agnostic sibling of
  `findTechnicianByTelegramUserId` [src/db/technicians.ts:34-45](../../src/db/technicians.ts#L34)
  (today tenant-scoped; a global bot has no tenant). Feature A **also** edits `technicians.ts`
  (`isInactiveState` [technicians.ts:352](../../src/db/technicians.ts#L352) + a possible seat-exempt
  "schedulable person") → **the one literally-shared file** (different functions).
- **The contract Feature B reads, Feature A rewrites — `get_team_schedule`:** definition at
  [src/mcp/server.ts:519](../../src/mcp/server.ts#L519); Feature A's own Open Question is "how do
  `get_team_schedule` / `get_schedule` render a null-technician row?" — i.e. A changes the exact
  per-stop shape B's renderer binds to.
- **The verbs Feature B drives, Feature A rewrites — `booking.ts`:** `bookVisit`/`moveVisit`/
  `cancelVisit` at [src/schedule/booking.ts:242/419/517](../../src/schedule/booking.ts#L242). A
  makes bookings technician-optional and redraws their confirmation; B's drag-to-move calls the same
  verbs and mirrors the same confirm flow.
- **The manager tool dispatch both might touch — `src/mcp/server.ts`:** A edits book/move/cancel
  dispatch ([server.ts:2145/2287/2419](../../src/mcp/server.ts#L2145)) + the confirm branches; B
  edits this file **only if** it chooses the "call the MCP tools / add a technician self-read tool"
  fork (its DP2/DP5) rather than the "new REST endpoints in httpServer.ts" fork.

## Key Files

### Feature A footprint (from its research doc + `grep` of the foundation)

| File | Why A touches it |
|---|---|
| new migration (`assignments`) | technician-optional: `DROP NOT NULL` on `technician_id` **or** a sentinel "unassigned" row (its DP1). Ripples into `no_confirmed_overlap` (technician_id-keyed exclusion, `20260704210155_scheduling_foundation.sql:70`) |
| [src/db/assignments.ts](../../src/db/assignments.ts) | `createAssignment` / technician-keyed readers under a nullable technician |
| [src/db/technicians.ts](../../src/db/technicians.ts) | `isInactiveState` (352) coupling; possible seat-exempt "schedulable person" (its DP2/DP3) |
| [src/db/jobTypeDurations.ts](../../src/db/jobTypeDurations.ts) | the 2-hour default that reached a confirmation (its DP5) |
| [src/schedule/booking.ts](../../src/schedule/booking.ts) | `resolveTechnician` (optional), `resolveBooking` (default), verb confirmation policy, `moveVisit` null handling |
| [src/db/reviewItems.ts](../../src/db/reviewItems.ts) | if the confirm model changes (drop/gate the `pending_booking`/`pending_visit_*` two-step) |
| [src/mcp/server.ts](../../src/mcp/server.ts) | book/move/cancel dispatch + confirm branches; `add_technician_seat` confirmation; **`get_team_schedule`/`get_schedule` null-technician rendering** |
| tests | `scheduling.test.ts`, `booking.test.ts`, `server.test.ts`, availability |

### Feature B footprint (from its survey + code reads)

| File | New/edit | Why B touches it |
|---|---|---|
| `web/board/*` (HTML/CSS/JS Mini App page) | **new** | the hosted page Telegram opens |
| initData-verify module | **new** | `HMAC_SHA256(botToken,'WebAppData')` (or Ed25519) server-side check |
| board-bot module | **new** | pure Bot API: launch button + `sendMessage` |
| notification-push module | **new** | poll `schedule_events` → push canned Telegram messages |
| [src/mcp/httpServer.ts](../../src/mcp/httpServer.ts) | **edit** | board/API/initData/CORS routes **before** the MCP fallthrough (253-260) |
| [src/db/technicians.ts](../../src/db/technicians.ts) | **edit** | tenant-agnostic global Telegram-id lookup (sibling of 34-45) |
| [src/mcp/server.ts](../../src/mcp/server.ts) | **conditional edit** | ONLY under the MCP-tools / technician-self-read fork (DP2/DP5) |
| reuses (read, no edit) | — | `get_team_schedule`'s underlying queries, `booking.ts` verbs, `scheduleEvents.ts` |

### The overlap, precisely

| File | Feature A | Feature B | Conflict type |
|---|---|---|---|
| `src/db/technicians.ts` | edits `isInactiveState` (352) + seat model | adds global Telegram lookup (near 34-45) | **literal, different functions** → low textual-conflict, but B's global lookup filters via `isInactiveState`, whose meaning A may redefine (its DP2 "which states are bookable") |
| `src/mcp/server.ts` | edits `get_team_schedule` render + confirm branches | edits ONLY under the MCP-tools/self-read fork | **conditional** — direct collision iff B picks that fork |
| `src/schedule/booking.ts` | rewrites the verbs | drives the verbs (no edit) | **contract** — B's write path depends on A's post-rewrite semantics (unassigned rows, confirm model) |
| `get_team_schedule` return shape | changes per-stop shape (null technician) | binds its renderer to it | **contract** — A moves the shape B renders |
| `src/mcp/httpServer.ts` | — | edits (board routes) | **none** — A doesn't touch it |

## Data Flows

**The dependency direction (why foundation-first, not the reverse):**

```
Feature A  (reshapes the FOUNDATION)                 Feature B  (a SURFACE on the foundation)
 ├ technician_id nullable / sentinel  ──────────────►  board must RENDER an "unassigned" stop
 ├ get_team_schedule per-stop shape   ──────────────►  board's day-view renderer binds to it
 ├ book/move/cancel confirm model     ──────────────►  drag-to-move in-UI confirm mirrors it
 └ isInactiveState / bookable states  ──────────────►  global Telegram lookup filters by it
                                                      (B → A only; A consumes nothing from B)
```

Read strictly left-to-right: **every** arrow points A → B. There is no arrow back. So the two are
not peers that happen to touch the same file — B is *downstream* of A's foundation reshape. Building
B in parallel against today's (pre-A) foundation means B's renderer binds to a `technicianRef` that
is always present, its write path assumes the current staged two-step, and its lookup filters by
today's `isInactiveState` — all three of which A is in the middle of changing. When A lands, B redoes
those three. Stacking A→B pays that cost once.

**Where a git-merge would (mis)report "no conflict":** the only file both edit textually is
`src/db/technicians.ts`, in different functions — three-way merge likely succeeds silently. That is
precisely the trap the "stack them" rule guards against: a clean textual merge that is a broken
*contract* merge (B's renderer still expects the old `get_team_schedule` shape). The footprint
overlap that matters is not the shared file; it is the shared *contract*.

## External Dependencies

No new external-service verification was required for this delta — the Telegram Bot API / Mini App
facts (initData HMAC, no-BotFather launch buttons, HTTPS requirement, `auth_date` freshness) were
verified live against `core.telegram.org/bots/webapps` + `/bots/api` in the sibling Feature B survey
on 2026-07-17 and are not re-derived here. The only live check this document ran is the **read-only
pilot migration ledger** (`mcp__supabase-test__list_migrations`) to resolve the Phase-5 question —
no writes, per the read-only + no-DB-writes ground rules.

## Constraints and Invariants

- **CLAUDE.md footprint rule is the governing test:** "Disjoint footprints → implement in parallel;
  overlapping → stack them; parallel implementation = two worktrees + `scripts/second-stack.sh`."
  The footprints here are overlapping (contract-level) → the rule selects **stack**.
- **`preview == commit`** across the booking verbs ([booking.ts:1-6](../../src/schedule/booking.ts#L1)):
  whichever confirm model Feature A settles on, Feature B must render the preview A produces, not
  recompute its own — so B cannot finalize its write UI until A's confirm decision is fixed.
- **Identity is boundary-established** ([identity.ts](../../src/mcp/identity.ts)): Feature B adds a
  *second* identity boundary (Telegram `initData`) beside the gateway HMAC. This is disjoint from
  Feature A (which touches neither) — the *auth* seam is genuinely parallelizable; only the *data
  contract* seam is not.
- **`findTechnicianByTelegramUserId` is tenant-scoped** ([technicians.ts:34-45](../../src/db/technicians.ts#L34)):
  B's global variant must filter with `isInactiveState` ([technicians.ts:44,352](../../src/db/technicians.ts#L44));
  Feature A's DP2 could change what that predicate admits, so B's lookup semantics are downstream of
  A's roster decision even though the two edit different functions.
- **Pilot schema is already at the promise-ladder migration** (`schedule_core_promise_ladder`,
  pilot version `20260715202139`, applied) — so any assumption that B "reads an older schema on the
  pilot" is false at the *schema* level. Data population (backfill) is the residual unknown.
- **Local vs linked migration timestamps diverge by design:** the same migration is
  `20260714120000` locally and `20260715202139` on the pilot (same name, re-stamped on push). Do not
  read the timestamp mismatch as "different migrations."

## Decision Points

Forks the current code + the two concurrent footprints create for Plan 2. Stated as forks; the
validation finding above is evidence, not a recommendation.

1. **Parallel vs stacked (the concurrent-RPI decision).** The footprints are overlapping (one shared
   file textually; `get_team_schedule` shape + booking verbs + confirm model + `isInactiveState`
   contractually). Fork: (a) **stack A→B** — land Feature A, then re-check/rebase Feature B's plan on
   the reshaped foundation (matches the CLAUDE.md rule and the B→A dependency direction); (b) **force
   parallel** — accept that B rebuilds its renderer, write-path confirm, and lookup filter when A
   lands, and that a clean-looking git-merge hides a broken data contract. The evidence points at (a).

2. **How Feature B reaches schedule data — and whether that pulls `src/mcp/server.ts` into the
   overlap.** (a) B calls the **MCP tools** / adds a technician **self-read tool** in `server.ts` →
   B now edits the *same* file A rewrites (`get_team_schedule` + confirm branches) → the overlap
   hardens from contract-only to **literal same-file**, strengthening the stack case. (b) B adds
   **new REST endpoints in `httpServer.ts`** that call the shared query/verb functions directly →
   B avoids `server.ts` entirely, leaving `technicians.ts` as the only literal shared file — but the
   *contract* coupling (return shape, confirm model) remains regardless of fork. This choice changes
   the *degree* of overlap, not the parallel-vs-stacked verdict.

3. **When Plan 1 Phase 5 lands on the pilot (gates B's live E2E, not B's build).** Confirmed: the
   migration is applied. Unconfirmed: the `--hosted` backfill (pilot `assignments` populated) and the
   Render web+cron redeploy. Fork: (a) finish Plan 1 Phase 5 on the pilot **before** B's live E2E
   (foundation-first, one layer down) — B builds/tests on the local stack meanwhile; (b) run B's
   live E2E against an un-backfilled pilot and see an empty board. Only (a) yields a meaningful live
   check.

4. **If A ships technician-optional, what B renders for a null-technician stop.** A's DP1 (nullable
   vs sentinel) decides whether `get_team_schedule` returns a stop with `technicianRef: null` or a
   sentinel ref. B's day-view must render that state. This is fully downstream of A — B cannot design
   the "unassigned" board cell until A picks its representation.

## Open Questions

Resolved by this delta (do not re-ask): *is the promise-ladder migration on the pilot?* → **yes,
applied** (`schedule_core_promise_ladder`, `20260715202139`). *Is the browser+Telegram surface
greenfield?* → **yes** (a fresh `grep` for `initData`/`web_app`/bot-token/CORS/static-serve in `src/`
returns nothing but the existing `telegram_user_id` binding). *Is the promise-default fix on main?*
→ **yes** (`97b8dcc` merged via PR #47 `e7a4bb7`, atop PR #46 date-grounding — so the code foundation
Feature B builds on is fully on `origin/main`).

Still needing a human or a run to resolve:

- **Has Plan 1's `--hosted` backfill run on the pilot?** Not readable from the migration ledger; a
  read-only `select count(*) from assignments` / `schedule_events` on the pilot would settle it. If
  empty, B's live board renders empty regardless of code correctness.
- **Has the Render web+cron been redeployed to post-Plan-1 code?** If the deployed web service still
  runs pre-Plan-1 code, B's new board routes have no coherent process to attach to until the
  redeploy — a deploy-sequencing constraint on B's rollout, not on its build.
- **Which fork does Feature B take for data access (DP2)?** The choice decides whether `server.ts`
  joins `technicians.ts` as a *literal* second shared file. Either way the stack verdict holds; the
  fork only changes how much rebasing B needs after A lands.
- **Does Feature A's plan intend to change the confirm model (drop/gate the two-step) or only its
  boundary?** If A retires the `pending_booking`/`pending_visit_*` staged flow, B's in-UI drag-to-move
  confirm must be designed against the new model — the single largest reason B must be re-checked
  after A rather than built beside it.

## Assumptions

Recorded because this is a non-interactive run (no ability to confirm with the user):

- **"The other concurrent feature" = Feature A = the technician-optional + confirmation-policy
  research** ([2026-07-17-technician-optional-and-confirmation-policy.md](2026-07-17-technician-optional-and-confirmation-policy.md)).
  Basis: it is the only other research doc written today (16:03 vs this track's 16:05), on the same
  branch and commit (`97b8dcc`), and both touch the same schedule/booking foundation — the signature
  of a `plan-two` concurrent run.
- **"Plan footprints" = research-derived footprints.** The CLAUDE.md rule compares two *plans'* file
  footprints, but neither plan is written yet (both tracks are still in Research). The footprints
  above are therefore taken from each feature's research doc + direct `grep`/reads of the code the
  research names. When both plans exist, re-run the footprint compare against the plans' actual
  "Changes required" file lists — the contract-overlap finding should hold, but the literal shared-file
  set may widen (esp. `server.ts`) depending on Feature B's DP2 fork choice.
- **"Foundation-first" resolves to A-first.** Feature A reshapes the booking foundation Feature B
  reads/drives; the dependency graph is strictly B→A. No reading of the code makes B a dependency of
  A, so foundation-first is unambiguous here.
</content>
</invoke>
