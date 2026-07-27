---
date: 2026-07-27
branch: main
commit: 2004529
topic: Read-only freeze-proposal view on the Telegram Mini App dispatch board — map of everything a plan would build on. Context — 4b-3 (PR #86) is live; the owner judged the chat-rendered proposal unreadable on the phone; direction = render the proposal on the board, shrink the chat message to summary + deep link + "reply yes"; confirmation stays chat-only (ritual doctrine).
---

## Summary

The weekly freeze is live: `run_freeze` (manager-invoked, or fired by an agent-side cron
under the §0h ritual contract) solves a placement plan and stages the WHOLE thing behind one
tenant-wide `pending_freeze` review item — placements, skips-with-reasons, per-technician
capacity, plus a schedule-version pin and a `stagedAt` stamp that backs a 12-hour expiry
enforced lazily at confirm time. Nothing about that staging touches the board today; in fact
the boardLink decoration seam **deliberately skips** `needs_confirmation` results
([src/mcp/server.ts:5457-5467](../../src/mcp/server.ts#L5457)), so the stage result is the one
`run_freeze` output that carries no board link at all. The phone-check verdict (owner,
2026-07-27, recorded in [docs/engineering-memory.md:353-358](../../docs/engineering-memory.md#L353))
is that the chat rendering of that plan fails on a phone; the direction is a read-only
proposal view on the existing board Mini App.

Everything a plan needs already exists in three well-shaped pieces: (1) the staged detail is
a complete, typed JSON object (`FreezePlan` + envelope) that a new GET endpoint could serve
almost verbatim; (2) the board has an established manager-gated read-endpoint pattern
(`/board/api/bucket`) and a full-screen sheet pattern (the loose-bucket tray) that is the
closest visual precedent for a proposal view; (3) the deep-link mechanism
(`t.me/<bot>?startapp`) exists but carries **no parameter today** — neither
[src/telegram/initData.ts](../../src/telegram/initData.ts) nor
[web/board/board.js](../../web/board/board.js) reads `start_param`, so "open straight into
the proposal" is new plumbing on both ends (small: mint `?startapp=<param>` server-side,
read `tg.initDataUnsafe.start_param` client-side). The chat-side shrink touches three copy
homes in three different rollout classes: the stage-result `note` (deploy-only), the
`run_freeze` tool description (deploy + fleet gateway restarts), and the §0h AGENTS.md block
(wire pass per sandbox). A recorded rider should travel with the change: `resolve_review`'s
description is written purely in pairing-verification terms, and the live E2E showed the
agent cannot connect it to dismissing a `pending_freeze` token.

Jargon expanded once: *Mini App* = Telegram's in-chat webview app (our board page);
*initData* = the signed "launch slip" Telegram hands the page, proving which account opened
it; *wire pass* = re-running `bootstrap-box.sh wire` on the fleet box so each sandbox's
AGENTS.md blocks refresh; *gateway restart* = `nemoclaw <s> gateway restart`, which re-fetches
the cached MCP `tools/list` (tool descriptions are fetched once per process).

## Entry Points

- **The stage branch** (what gets stored): [src/mcp/server.ts:4599-4697](../../src/mcp/server.ts#L4599)
  — `case 'run_freeze'`, no `confirmId` → solve, supersede, upsert, pin detail, return
  `needs_confirmation`.
- **The confirm branch** (the expiry/version rules a view must mirror):
  [src/mcp/server.ts:4699-4745](../../src/mcp/server.ts#L4699).
- **The plan types**: [src/schedule/freezeSolve.ts:59-136](../../src/schedule/freezeSolve.ts#L59)
  (`FreezePlacement` :118, `FreezeSkip` :95, `FreezeCapacity` :101, `FreezePlan` :130) and
  `PINNED_SKIP_REASON` :152.
- **The review-item store**: [src/db/reviewItems.ts](../../src/db/reviewItems.ts) —
  `upsertOpenReviewItem` :47, `updateOpenReviewItemDetail` :198, `getOpenReviewItem` :219,
  `findOpenReviewItemsByKind` :242.
- **The board HTTP surface**: [src/telegram/boardApi.ts:177-754](../../src/telegram/boardApi.ts#L177)
  (`handleBoardRequest`), auth in `authBoard` :74, mounted before the IP allowlist in
  [src/mcp/httpServer.ts:262-288](../../src/mcp/httpServer.ts#L262).
- **The board client**: [web/board/board.js](../../web/board/board.js) — render :304, tabs
  :277, sheet machinery :1016-1040, the tray (closest precedent) :589-705; shell
  [web/board/index.html](../../web/board/index.html); styles [web/board/board.css](../../web/board/board.css).
- **The link mint**: `boardMiniAppLink` [src/mcp/server.ts:1226-1240](../../src/mcp/server.ts#L1226);
  `BOARD_LINK_TOOL_NAMES` :1198-1224 (includes `run_freeze` :1223); the decoration seam
  :5454-5478.
- **The chat-copy homes**: §0h block
  [Box_Setup_Stuff/bootstrap-box.sh:799-835](../../Box_Setup_Stuff/bootstrap-box.sh#L799);
  `run_freeze` tool description [src/mcp/server.ts:849-874](../../src/mcp/server.ts#L849);
  stage-result `note` :4689-4696.
- **The rider**: `resolve_review` description [src/mcp/server.ts:876-890](../../src/mcp/server.ts#L876);
  `STAGED_ACTION_KINDS` :5353-5363.

## Key Files

| File | Role for this feature |
|---|---|
| `src/mcp/server.ts` (5,527 ln) | Stages/consumes the plan; mints the board link; owns two of the three copy homes and the `resolve_review` rider. |
| `src/schedule/freezeSolve.ts` (769 ln) | Defines every type inside `detail.plan` and composes every skip-reason string a view would display verbatim. |
| `src/db/reviewItems.ts` (309 ln) | The typed store. No expiry column exists — expiry is derived from `detail.stagedAt`. `pending_freeze` is in the `ReviewKind` union :27. |
| `src/telegram/boardApi.ts` (754 ln) | Where a `GET /board/api/freeze` (or similar) endpoint would be added; the auth + tier-gating pattern to copy is `/board/api/bucket` :275-287. |
| `src/telegram/initData.ts` (79 ln) | Verifies the launch slip. Parses only `hash`, `auth_date`, `user` — `start_param` is signature-covered but never read. |
| `web/board/board.js` (2,030 ln) | Plain script, no build step (client mirrors of server constants are the house pattern, :1158-1173). A proposal view mounts either as a sheet (tray idiom) or a third tab. |
| `web/board/board.css` (415 ln) | `.detail-sheet` :242, `.tabs` :72, `.bucket-*` rows :43-53 — the visual vocabulary a proposal list would reuse. |
| `Box_Setup_Stuff/bootstrap-box.sh` (1,094 ln) | §0h freeze-ritual block :810-831 — the "show the ENTIRE proposal in chat" mandate that would shrink. Delete-then-append refreshable :804-807. |
| `docs/engineering-memory.md` | Rollout-class rules (:192-195, :248-249, :459-465) and the two recorded findings this feature answers (:341-359). |

## The staged `pending_freeze` detail — exact shape

`run_freeze`'s stage branch builds `stagedDetail` at
[src/mcp/server.ts:4656-4662](../../src/mcp/server.ts#L4656) and pins it onto the open row via
`updateOpenReviewItemDetail` :4674 (the stage-race close: the upsert may return another
racing call's row, so OUR detail is written onto whichever row we got; `null` → restage
error :4675-4677). What a read endpoint would find in `review_items.detail`:

```jsonc
{
  "plan": {                       // FreezePlan — freezeSolve.ts:130-136
    "horizonFrom": "2026-07-27",  // YYYY-MM-DD, firm-local today at stage time
    "horizonTo":   "2026-08-09",  // today+13 default; throughDate can narrow/extend (cap +31)
    "placements": [               // FreezePlacement[] — freezeSolve.ts:118-128
      {
        "kind": "unscheduled_job",       // 'unscheduled_job' | 'unassigned_visit' | 'unplaced_visit' (:59)
        "jobId": "<uuid>",
        "assignmentId": null,            // null = job had no visit yet
        "customer": "Ada Diaz",          // string | null
        "jobTitle": "Water heater swap", // string | null
        "technicianRef": "mike-c",
        "date": "2026-07-29",            // YYYY-MM-DD
        "startTime": "09:00",            // HH:MM naive-local
        "endTime": "10:30"               // HH:MM (booking-layer 23:59 same-day clamp)
      }
    ],
    "skipped": [                  // FreezeSkip[] — freezeSolve.ts:95-99, input-side + solver-side in ONE list
      { "ref": "<assignmentId | job:<id> | tech:<ref>>",
        "label": "Ada Diaz — Water heater swap",   // skipLabel(): "customer — title", or 'unnamed'
        "reason": "<server-composed string, relayed verbatim>" }
    ],
    "capacity": [                 // FreezeCapacity[] — freezeSolve.ts:101-106; committedMin INCLUDES the plan's placements
      { "technicianRef": "mike-c", "technicianName": "Mike Chen",
        "committedMin": 780, "availableMin": 2400 }
    ]
  },
  "scheduleVersion": 41,          // pinned BEFORE the solve (server.ts:4634-4640)
  "horizonFrom": "2026-07-27",    // duplicated on the envelope (:4659-4660)
  "horizonTo": "2026-08-09",
  "stagedAt": "2026-07-27T14:03:22.101Z"  // ISO — the 12h expiry's sole basis
}
```

Two shape gotchas for a view:

- **Weekday is NOT stored.** The stage *response* decorates each placement with
  `weekday: weekdayLabel(p.date)` (:4686 — "server-computed weekday on every emitted date,
  the house rule"), but the stored plan has bare dates. A read endpoint either re-computes
  weekdays server-side (house rule) or the client's existing `dayName()`
  ([web/board/board.js:119-122](../../web/board/board.js#L119)) does it — board.js already
  computes weekdays from stored dates everywhere.
- **The row envelope** is a plain `review_items` row (`ReviewItem`,
  [src/db/reviewItems.ts:5](../../src/db/reviewItems.ts#L5)): `id` (= the `confirmId`),
  `tenant_id`, `kind: 'pending_freeze'`, `subject_ref` (= the STAGING manager's roster ref;
  any active manager may confirm, :4699-4700), `status: 'open'`, `suggestion`, `detail`,
  `created_at`, `resolution`, `resolved_at`.

### The skip-reason catalog (all composed in freezeSolve.ts, relayed verbatim)

| Anchor | Reason string (exact) |
|---|---|
| :152-153 | `PINNED_SKIP_REASON` = `'pinned by a manager — the freeze never touches pinned visits'` — an **exported constant** precisely so counters match it exactly, never a substring grep (the stage response's pin line counts these, server.ts:4678) |
| :146-147 | `"no length set — ask how long it takes and record it (update_job durationMinutes), then run the freeze again"` (`LADDER_REMEDY`) |
| :155-158 | `'customer has no usable street address on file'` / `"customer's address couldn't be located on the map — check/correct it"` |
| :180-185 | `'no working pattern set — invisible to the freeze (set_availability fixes this)'` (ref = `tech:<ref>` — a *person* skip, not a visit skip) |
| :329, :378 | `` `beyond this freeze's horizon (…)` `` (two variants) |
| :333-339, :341-347 | past-date person-less rows: `"its date (…) already passed with nobody attached — rebook it, or fix it in chat"` / `'its time today has already passed with nobody attached — move it, or handle it in chat'` |
| :374 | `'its whole day range has passed — recover or re-fence it in chat'` |
| :420-434 | assigned-to-pattern-less / no-working-days variants (named person embedded) |
| :668-673, :686 | orphan / `'nobody has a working pattern in this horizon — set_availability, then rerun'` |
| :747-749 | solver-side: `'no room in this window — every fitting day is full (or the visit clashes with existing bookings)'` / `'the solver returned no slot for this visit — rerun the freeze; if it persists, place it by hand'` |
| :760-765 | context note: `"an EXISTING booking sits outside this person's working pattern — kept as booked (the freeze never moves placed visits); it still counts toward their day"` |

### Reads available today

- `findOpenReviewItemsByKind(tenantId, 'pending_freeze')`
  ([src/db/reviewItems.ts:242-255](../../src/db/reviewItems.ts#L242)) — every OPEN token,
  tenant-wide, oldest first. The partial unique index is per (tenant, kind, **subject**), so
  two managers *could* each hold one; staging dismisses kind-wide first (server.ts:4653-4655)
  so in practice ≤1 is open, but a reader should still handle >1 (take the newest or treat as
  anomaly).
- `getOpenReviewItem(id, tenantId, { kind: 'pending_freeze' })` (:219-235) — point read,
  tenant + kind + open all in the WHERE clause.
- `list_pending_reviews` deliberately **summarizes** the freeze token
  ([src/mcp/server.ts:5271-5296](../../src/mcp/server.ts#L5271)) — counts only, with
  `summary: 'a staged freeze plan — confirm or restage via run_freeze, never relay from here'` —
  to keep hundreds of possibly-stale rows out of the agent's context. The board endpoint
  would be the first surface that serves the FULL stored plan to a human.

## Board architecture to hook into

### Server side (boardApi.ts)

Route table in `handleBoardRequest` (all under `/board`, routed by
[src/mcp/httpServer.ts:262-288](../../src/mcp/httpServer.ts#L262) **before** the IP allowlist
— board traffic is users' public phones, not the gateway):

| Route | Method | Tier | Anchor |
|---|---|---|---|
| `/board`, `/board/` | GET | none (page shell) | :188-191 |
| `/board/static/*` | GET | none (assets; html/js/css whitelist, traversal-proof) | :192-195, :121-146 |
| `/board/api/day` | GET | both (technician auto-self-filtered; manager `view=mine` echo) | :197-234 |
| `/board/api/visit` | GET | both (technician sees own only; uniform 404) | :240-270 |
| `/board/api/bucket` | GET | **manager-only 403** | :275-287 |
| `/board/api/roster` | GET | **manager-only 403** | :291-303 |
| `/board/api/move|cancel|book|promise|lock|job` | POST | **manager-only 403** | :310-741 |

- **Auth**: every `/board/api/*` call carries `Authorization: tma <raw initData>`;
  `authBoard` (:74-106) verifies the signature against `BOARD_BOT_TOKEN`
  ([src/telegram/initData.ts:31-78](../../src/telegram/initData.ts#L31) — HMAC per Telegram's
  scheme, 24h `auth_date` replay bound), then resolves the Telegram user id to a roster row
  (60s memo via `rosterCache`), which supplies the tenant. Failure posture: bare 401 for
  anything auth-shaped; 409 only for an ambiguous account; DB faults propagate to a logged 500.
- **The endpoint pattern to copy** for a proposal read is `/board/api/bucket`: auth →
  manager 403 → one read → `json(res, 200, …)` serving the read-layer's shape verbatim.
- **Response-shaping convention**: `/api/day` returns `{ tier, self, view, ...days }` — the
  server echoes the *resolved* view so the client renders what was actually filtered
  (:203-225). Server-composed display strings travel verbatim; the client does no date math
  beyond weekday-from-YYYY-MM-DD.

### Client side (board.js / board.css)

- **State + views**: one `state` object (:27-44); `view: 'team' | 'mine'` with a
  manager-only `tabsBar()` (:277-284); technicians never see tabs. `render()` (:304-367)
  paints header (title + bucket pill + tabs + week pager) then day sections.
- **Day grid**: `renderDay` (:215-275) — per-technician `lane()`s on the Team tab, a flat
  list otherwise; the "No time yet" `tbd-strip` (:229-234) with `tbdCard` rows (:194-213);
  `stopCard` (:147-167) with promise/📌 badges (:124-145).
- **The sheet pattern** — the natural mount for a proposal view: a single
  `#detail-overlay` element hosting a `.detail-sheet` (slide-up dialog, CSS-owned motion,
  `closeDetail` :868-876). Generic helpers `openSheet(html, onClick)` (:1016-1032) and
  `sheetShell(title, inner)` (:1034-1040). The **loose-bucket tray** is the closest
  precedent end-to-end: a header pill (`bucket-pill`, count filled async post-paint
  :335-340, :497-512), tap → re-fetch-on-open (`openBucket` :620-705, "never stale"),
  sectioned rows with server-composed strings (`renderBucketSheet` :589-618). A proposal
  view is the same shape: manager-only fetch, sectioned read-only rows (placements / skips /
  capacity), rendered in the sheet or as a full view.
- **Mount options visible in the code**: (a) a third tab in `tabsBar()` (manager-gated like
  the existing two); (b) a header pill beside `bucket-pill`; (c) sheet-only, opened by deep
  link. No routing/hash mechanism exists — views are functions that repaint `#app` or open
  the overlay.
- **CSS vocabulary**: `.detail-sheet` :242-261 (incl. `prefers-reduced-motion`), `.tabs`
  :72, `.bucket-section/.bucket-row/.bucket-row-sub` :43-53 + :353-366, `.badge`/`.badge.pinned`
  :280-291, `.tbd-strip` :392. Telegram theme variables applied at boot (`applyTheme` :60-73).
- **No build step**: board.js is plain script; server constants that matter client-side are
  mirrored with keep-in-lockstep comments (e.g. `DURATION_LADDER` :1164). A 12h-expiry
  constant or status strings for the proposal view would follow the same mirror-or-serve rule
  (serving computed state avoids the mirror entirely).

## Deep-linking: today vs what "open the proposal" takes

**Today**: `boardMiniAppLink()` ([src/mcp/server.ts:1226-1240](../../src/mcp/server.ts#L1226))
returns `https://t.me/<BOARD_BOT_HANDLE>?startapp` — validated bot-username, **no parameter**.
It rides only via the ONE decoration seam (:5454-5478): tools in `BOARD_LINK_TOOL_NAMES`
(:1198-1224, `run_freeze` included :1223) get `boardLink` + a fused `boardNote`
("ALWAYS end this reply with the exact line: [See it on the board](…)") — but **only when
`status !== 'needs_confirmation'`** (:5462-5467). The comment records why: staging writes
nothing, so the board would show the OLD schedule at the exact moment precision matters.
That rationale **inverts** once a proposal view exists — the board *could* then show the
staged plan — so the plan must decide whether to relax this exclusion for `run_freeze` only,
or mint a distinct field (e.g. `proposalLink`) for the stage result and leave the seam's
rule intact for every other staged tool. The agent is instructed to relay `boardLink`,
never invent a URL (:1197) — the fabrication incident that forced this is recorded at
:1207-1212.

**Telegram mechanics**: `t.me/<bot>?startapp=<param>` delivers `<param>` to the Mini App as
`start_param` — inside the signed initData (server-verifiable; it participates in the
`data_check_string`) and client-side as `Telegram.WebApp.initDataUnsafe.start_param`. The
link works from ANY chat (:1195-1196, citing https://core.telegram.org/bots/webapps).

**What's missing (both ends, both small)**:
1. Server: mint `?startapp=<param>` (e.g. `startapp=freeze`) for the stage result. Note the
   URL is built in `server.ts`, not boardApi — the board API never mints links.
2. Client: nothing reads `start_param` today. Boot code (board.js :1998-2029) would check
   `tg.initDataUnsafe.start_param` after first render and open the proposal view.
   `initData.ts` needs no change — client-side routing needs no authority, because the
   proposal endpoint independently authenticates and tier-gates every fetch (a technician
   tapping a forwarded manager link hits the endpoint's 403, exactly like the bucket).
3. Param payloads: a bare view name suffices — the endpoint serves "the open proposal"; the
   token id in the link buys nothing (and a stale one would 404-shape anyway, mirroring the
   confirm path's 'confirmation not found').

## Data flow (current staging + the proposed read path)

```
 manager (or §0h cron)                     Telegram phone
        │ "run the freeze"                        │
        ▼                                         │
 agent → run_freeze (stage) ── solveFreeze ──► FreezePlan
        │  server.ts:4599                         │
        │  dismiss open tokens kind-wide (:4653)  │
        │  upsert review_items pending_freeze     │
        │  detail={plan,scheduleVersion,          │
        │          horizon*,stagedAt} (:4656)     │
        ▼                                         │
 stage result: needs_confirmation + confirmId     │
        │  (NO boardLink today — seam :5462)      │
        ▼                                         ▼
 chat message ── would shrink to ──►  summary + t.me/<bot>?startapp=<param>
        │                                         │ tap
        │                                         ▼
        │                          board.js boot reads start_param (NEW)
        │                                         │
        │                          GET /board/api/<freeze> (NEW, bucket pattern:
        │                          tma auth → manager 403 → read → 200)
        │                                         │
        │                 findOpenReviewItemsByKind(tenant,'pending_freeze')
        │                 + expiry math on detail.stagedAt (mirror :4713)
        │                                         ▼
        │                          read-only proposal view (sheet/tab)
        ▼                                         │
 manager replies "yes" IN CHAT ◄──── "reply yes in chat" (copy only, no button)
        │
 run_freeze (confirm, ONLY confirmId) — expiry :4713, version pin :4721,
 consume-then-commit :4735-4745 — board link rides the COMMITTED result
```

## Chat-side copy that would shrink — and each piece's rollout class

Three homes currently mandate the full-plan relay:

1. **§0h AGENTS.md block** — [Box_Setup_Stuff/bootstrap-box.sh:810-831](../../Box_Setup_Stuff/bootstrap-box.sh#L810),
   item 1: *"call run_freeze and show the ENTIRE proposal: every placement (weekday, date,
   time, who, customer), every skipped item WITH its reason … each technician's committed
   vs available minutes, and the pin line"*. Already **refreshable** (delete-then-append on
   the `## The freeze ritual` heading, :804-807) — built exactly so this text can evolve.
   **Rollout: wire pass** (`bootstrap-box.sh wire` on s2/s3/s5/s7/s8) — the step gateway
   restarts do NOT cover (recorded rule, [docs/engineering-memory.md:192-195](../../docs/engineering-memory.md#L192)).
2. **`run_freeze` tool description** — [src/mcp/server.ts:850-865](../../src/mcp/server.ts#L850):
   *"Show the manager ALL of it (placements, skips, capacity, the pin line)…"* plus the
   boardNote instruction. **Rollout: deploy + fleet gateway restarts** — MCP tool
   descriptions are fetched once per process (recorded rule,
   [docs/engineering-memory.md:459-465](../../docs/engineering-memory.md#L459)).
3. **Stage-result `note`** — [src/mcp/server.ts:4689-4696](../../src/mcp/server.ts#L4689):
   *"NOTHING is booked yet. Show the manager the WHOLE plan… The pin line — always say it…"*.
   Result strings are per-call. **Rollout: deploy-only, no restarts** (the temporal-rider
   precedent, [docs/engineering-memory.md:248-249](../../docs/engineering-memory.md#L248)).

Note the layering: the note is the strongest lever on live behavior (fused
instruction-in-result is the pattern that fixed link fabrication, :5471-5476); the §0h block
is the doctrine statement; the description is discovery-time framing. A shrink that edits
only one home leaves the other two still commanding a full relay.

## Rider: `resolve_review` copy (should travel with this change)

Current description, verbatim ([src/mcp/server.ts:876-890](../../src/mcp/server.ts#L876)):

> 'Close a review item (manager only) as resolved (handled) or dismissed (not an issue). ' +
> 'For a pairing verification: resolved = the mailbox is right (person goes active); ' +
> 'dismissed = wrong mailbox (pairing is torn down for a fresh connect link).'

Nothing mentions staged tokens. The handler, meanwhile, hard-refuses `resolved` on every
staged kind via `STAGED_ACTION_KINDS` ([src/mcp/server.ts:5353-5369](../../src/mcp/server.ts#L5353))
— `pending_freeze: 'run_freeze'` at :5362 with the review-finding comment ("without this
entry, resolve_review would 'resolve' the freeze plan while booking nothing"); `dismissed`
(= cancel the proposal) is the legitimate path. The live E2E
([docs/engineering-memory.md:347-353](../../docs/engineering-memory.md#L347)): the agent,
asked to dismiss a staged freeze, claimed *"the only lever is 12h expiry"* and dismissal
nudges made it **re-run the freeze** (kind-wide supersede) instead; it used
`list_pending_reviews` → `resolve_review dismissed` correctly the moment it was pointed
there. This is a description-only fix → same **gateway-restart** rollout class as item 2
above, which is why it should ride the same fleet pass.

## Expiry / empty / superseded states — what the endpoint would face

How the lifecycle actually works (there is **no sweeper**: `runLifecycle`'s cron sweeps
pairing, offboarding, and sessions only — [src/jobs/lifecycle.ts](../../src/jobs/lifecycle.ts);
`pending_freeze` is referenced nowhere outside `server.ts` and `reviewItems.ts`):

| State | DB reality | Where it is enforced today | Confirm-path copy (the vocabulary a view can mirror) |
|---|---|---|---|
| **None open** | `findOpenReviewItemsByKind` → `[]` | — | 'confirmation not found — run run_freeze again for a fresh plan' (:4703) |
| **Open + fresh** | `status='open'`, `stagedAt` < 12h old | — | the live proposal |
| **Expired, unswept** | row STILL `status='open'`; nothing changes it until touched | Confirm computes `Date.now() - Date.parse(stagedAt) > 12 * 3600_000` (:4713), then dismisses with resolution `'freeze proposal expired (12h)'` and throws 'this freeze proposal expired (12 hours) — run the freeze again for a fresh plan' (:4714-4715) | a read endpoint mirroring the rule does the same arithmetic on `detail.stagedAt` — serving the raw row without it would show a dead plan as live |
| **Superseded** | old token `status='dismissed'`, resolution `'superseded by a new freeze run'` (:4654); a NEW open token exists | stage-time, kind-wide (:4653-4655) | an open-only read naturally returns the newest; a deep link minted for the OLD proposal finds the same view (the link needs no token id for exactly this reason) |
| **Schedule changed under it** | token open + fresh, but `latestScheduleVersion(tenantId) !== detail.scheduleVersion` | confirm-time (:4721-4733), dismisses with `` `schedule changed under the plan (v… → v…)` `` | the comment at :4710-4712 calls the version pin "the REAL staleness guard", not the clock — a view that checks only the clock can show a plan the confirm will refuse; whether the endpoint also compares versions is a design choice |
| **Malformed detail** | open row, `!d.plan` or non-number `scheduleVersion` | confirm dismisses 'malformed staged plan' (:4717-4720) | endpoint should degrade the same way, not 500 |

## External Dependencies

- **Telegram Mini Apps platform** — `t.me/<bot>?startapp[=param]`, `start_param` delivery,
  initData signing: https://core.telegram.org/bots/webapps (already cited at
  server.ts:1195-1196 and initData.ts:9). Per the CLAUDE.md rule, a plan should re-verify
  `start_param` behavior against the live docs before building (this doc records the repo's
  current understanding, not a fresh vendor check).
- **BotFather config** — the board bot's Main Mini App must be configured for `?startapp` to
  launch (operator step, already done for the pilot; `BOARD_BOT_HANDLE` env on Render).
- **Env**: `BOARD_BOT_HANDLE` (link mint; unset = links absent, dev/local), `BOARD_BOT_TOKEN`
  (initData verify), `BOARD_STATIC_DIR` (asset root).
- No new vendor calls: the proposal view reads only our own DB via the existing typed layer.

## Constraints and Invariants

- **The ritual doctrine is untouchable**: confirmation happens ONLY in chat with an explicit
  human yes (§0h items 1-2; the owner's direction explicitly keeps this). The board view is
  read-only — no confirm button, no write endpoint. All six existing board write verbs stay
  manager-gated and none touches review items.
- **The board never shows what the agent must not relay stale**: `list_pending_reviews`
  summarizes precisely to keep possibly-stale placements away from the agent
  (:5271-5274). The board view serves the full plan to the HUMAN — the confirm-time version
  pin still protects the commit regardless of what anyone saw.
- **One seam for link decoration** (:5454-5457) — a proposal link should not fork a second
  decoration path per-tool; whatever ships must keep "one seam covering every return path".
- **`PINNED_SKIP_REASON` is matched exactly, never substring-grepped** (freezeSolve.ts:149-151)
  — a client pin counter must compare the whole string or consume a server-computed count.
- **Server-composed strings verbatim; no client date math** beyond weekday-from-date
  (board.js header comment :1-5). Times are naive-local `HH:MM`; dates name themselves.
- **Board reads are tier-gated server-side per route**; client gating is disclosure only
  (the `canEdit`/`why` pattern, board.js :733-861 — a read-only surface SAYS WHY, 4a.6
  user finding).
- **L1/append-only rules are not in play** — review items are ordinary mutable L2-adjacent
  state; no capture semantics here.
- **PR required for main** (code change); served board.js must be byte-verified against main
  after deploy (recurring rollout check, engineering-memory :190-191, :322-323).

## Decision Points (factual, no recommendations)

1. **Tab vs deep-linked-only view**: `tabsBar()` currently renders exactly two tabs,
   manager-only (board.js :277-284); the bucket pill shows the header-entry alternative
   (:335-340); no client routing exists, so a deep-link-only view still needs an in-page
   entry decision (or deliberately none).
2. **What the board shows for expired / superseded / none**: the endpoint can distinguish
   all the states in the table above; the confirm path already owns copy for each
   (expired :4715, not-found :4703, version-dead :4729-4732). Whether the view mirrors the
   version-pin check (the "REAL staleness guard") or clock-expiry only is part of this
   decision.
3. **Whether the view shows a "reply yes in chat to confirm" hint**: doctrine forbids a
   confirm affordance; a hint is copy-only. The chat message's own "reply yes to confirm"
   (owner's sketch) and the board hint would be the two places that describe the same next
   step.
4. **Technician visibility**: every proposal-adjacent surface today is manager-only —
   `run_freeze` itself (manager tool), `/board/api/bucket` and `/board/api/roster` (403),
   the tray pill (never rendered for technicians). A technician-visible proposal would be
   the first non-manager exposure of pre-commit scheduling intent.
5. **Chat-message shrink scope**: §0h-only, or also the stage-result `note` (and the tool
   description's "Show the manager ALL of it" sentence). Three homes, three rollout classes
   (wire pass / deploy-only / gateway restarts); the fused result-note is the historically
   strongest behavioral lever.

## Open Questions

- **Relax the seam or mint a new field?** The `needs_confirmation` exclusion at :5458-5461
  was written for staged writes the board can't show; a proposal view invalidates that
  premise for `run_freeze` only. Options visible in the code: per-tool exception inside the
  seam, or a distinct `proposalLink`/`boardNote` variant on the stage result. Either way the
  `?startapp=<param>` mint changes `boardMiniAppLink()`'s single-caller assumption.
- **Serve raw detail or a board-shaped projection?** Raw detail is complete but weekday-less
  and unsorted; a projection could add weekdays (house rule), group placements by
  technician/day (the lane idiom), and pre-compute the pinned count against
  `PINNED_SKIP_REASON` server-side.
- **Does the stage response itself need the placements once the board shows them?** Today the
  stage result carries the full plan for the chat relay (:4686-4688); a shrunken chat message
  may or may not still want the full payload in the tool result (the agent summarizes FROM
  it), which is a token-cost question on GLM, not a correctness one.
- **Cron-fired proposals with `BOARD_BOT_HANDLE` unset** (dev/local): links are absent by
  design (:1196-1197) — what does the shrunken chat message say then? The current §0h text
  has no board dependency; a shrink that assumes a link needs a fallback sentence.
- **Multiple-open anomaly**: staging closes tokens kind-wide, but the unique index alone
  permits one open token per manager (reviewItems.ts :237-241). Does the endpoint serve
  newest-wins, or surface the anomaly?
- **`start_param` freshness**: initData is re-signed at every launch (24h `auth_date` bound,
  initData.ts :56-64), so a tapped deep link always carries a fresh slip; a proposal that
  expired between message and tap resolves via the endpoint's expired state, not via auth.
