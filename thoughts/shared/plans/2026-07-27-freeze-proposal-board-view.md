---
date: 2026-07-27
task: Read-only freeze-proposal view on the dispatch board + chat-message shrink + resolve_review copy rider
research: thoughts/shared/research/2026-07-27-freeze-proposal-board-view.md
status: draft
---

## Overview

The 4b-3 freeze is live, but its chat-rendered proposal failed the owner's phone check
("scheduling formatting looks weird in texts"). This plan renders the staged proposal as a
**read-only view on the existing board Mini App**, shrinks the chat message to a short
summary + deep link + "reply yes to confirm", and fixes the `resolve_review` description
whose pairing-only copy hid the dismiss lever from the agent (live-E2E finding). The ritual
doctrine is untouched: **confirmation happens only in chat** — the board view has no write
path.

## Decisions

- **Entry point (user, 2026-07-27): deep link + header pill, no tab.** The chat message
  links straight into the proposal; the board shows a manager-only "Freeze proposal" pill
  (bucket-pill idiom) while one is open. A permanent tab was rejected (empty outside the
  ~12h window).
- **Visibility (user): manager-only.** Endpoint 403s technicians, pill never renders for
  them — consistent with every proposal-adjacent surface today (research §Decision 4).
- **Staleness (implementer): the view mirrors BOTH guards** — the 12h clock on
  `detail.stagedAt` AND the schedule-version pin (the confirm path's "REAL staleness
  guard", server.ts:4710-4712) — and states are served by the endpoint (`open` / `expired` /
  `stale` / `none`), so the client never does expiry math. Serving computed state avoids the
  no-build-step constant-mirror problem (research: board.js:1158-1173).
- **Confirm hint (implementer): yes, copy-only.** The view footer says "To confirm: reply
  *yes* to the assistant in chat — this page can't book anything." Doctrine forbids a
  button; a sentence is the loop-closer.
- **Link mint (implementer): keep the ONE decoration seam, add one narrow branch.** The
  seam's `needs_confirmation` exclusion (server.ts:5458-5467) stays for every staged tool;
  `run_freeze`'s stage result alone gets `proposalLink` (= `boardMiniAppLink('freeze')`) +
  a fused note line. Rationale: the exclusion's premise ("the board would show the OLD
  schedule") inverts only for this tool. No second decoration path (invariant,
  research §Constraints).
- **Endpoint serves a projection, not the raw row**: weekday added per placement
  (house rule, `weekdayLabel` from `src/schedule/fit.ts`), `pinnedCount` computed
  server-side by exact `PINNED_SKIP_REASON` match (never substring), `expiresAt` computed,
  placements passed through verbatim otherwise (server-composed strings travel verbatim).
- **Chat shrink scope (implementer): all three homes** — stage-result note (deploy-only),
  `run_freeze` description (gateway restarts), §0h block (wire pass). Editing one home
  leaves the other two commanding a full relay (research §copy homes). **Fallback:** when
  `BOARD_BOT_HANDLE` is unset (dev/local), no link is minted — the note and §0h both say:
  no link ⇒ show the ENTIRE plan in chat as before.
- **Stage result keeps the full plan payload.** The agent summarizes FROM it; dropping it
  is a GLM token-cost optimization with correctness risk (agent would have nothing to
  summarize). Recorded as a later option, not taken.
- **Multiple-open anomaly: newest `stagedAt` wins** (kind-wide dismiss at stage keeps ≤1 in
  practice; the per-subject unique index permits more — research §Open Questions).
- **12h constant single-sourced**: `FREEZE_PROPOSAL_TTL_MS` exported from the new
  projection module; the confirm branch's inline `12 * 3600_000` (server.ts:4713) switches
  to it.
- **Vendor check done at plan time** (CLAUDE.md rule): `?startapp=<param>` → `start_param`
  in signed initData + `initDataUnsafe.start_param` + `tgWebAppStartParam` GET param; works
  from any chat. https://core.telegram.org/bots/webapps (fetched 2026-07-27). Design does
  not trust it anyway — the endpoint independently auths and tier-gates every fetch.

## Plain-language walkthrough

**Phase 1 — the server learns to serve the proposal.** The staged freeze plan already sits
in the database as one complete object. This phase adds a read-only board endpoint that
hands it to a manager's phone — with the same freshness rules the confirm step enforces, so
the page can never show a dead plan as live. It also teaches the chat message to carry a
link that opens the board straight onto the proposal.

**Phase 2 — the board shows it.** A small "Freeze proposal" chip appears in the board
header while a proposal is waiting (managers only). Tapping it — or the link in chat —
slides up a read-only sheet: the placements grouped by day, everything skipped with its
reason, each tech's committed-vs-available hours, the pin line, and one footer sentence:
reply *yes* in chat to confirm. No buttons that book anything.

**Phase 3 — the chat message shrinks, and the fleet learns the new manners.** The agent's
proposal message becomes: "Freeze proposal ready — 3 placed, 3 skipped, 1 pinned untouched.
Review it on the board: [link]. Reply yes to confirm." The full table only appears in chat
if the board link isn't available. The same rollout pass fixes the `resolve_review`
description so the agent knows dismissing a staged freeze is its job.

```
chat: short summary + [Review on the board] + "reply yes"
                    │ tap
                    ▼
   board pill ─► read-only proposal sheet (placements/skips/capacity/pin line)
                    │
      "reply yes in chat" ──► confirm stays in chat (unchanged)
```

## Secrets & env preflight

- **All phases: none new.** `BOARD_BOT_HANDLE` (link mint) and `BOARD_BOT_TOKEN` (initData
  verify) — both `already required` and live on Render. Local dev without them degrades by
  design (no link ⇒ full chat relay).

## Phase 1: Proposal read endpoint + deep-link mint

### What this phase does
Server only: a projection module, a manager-gated GET endpoint, `boardMiniAppLink` gains a
param, the decoration seam gains the one narrow `run_freeze`-stage branch.

### Changes required

**`src/schedule/freezeProposal.ts`** (new, pure — no I/O)
- `export const FREEZE_PROPOSAL_TTL_MS = 12 * 3600_000;`
- `export function projectFreezeProposal(items: ReviewItem[], latestVersion: number, nowMs: number): FreezeProposalView`
  — picks newest `detail.stagedAt` among open items; returns
  `{ state: 'none' } | { state: 'expired' | 'stale', message } | { state: 'open', confirmStagedAt, expiresAt, horizonFrom, horizonTo, pinnedCount, placements: (FreezePlacement & { weekday })[], skipped, capacity }`.
  Malformed detail (`!d.plan`, non-number `scheduleVersion`, **or non-string/unparseable
  `stagedAt`** — the confirm path's extra `d.stagedAt &&` guard at :4713; without this a
  valid-plan row with missing stagedAt would serve `expiresAt: NaN` as `open` and break
  newest-wins ordering, review finding 2) ⇒ `none` (mirror server.ts:4717-4720; never
  throw). Newest-wins compares only valid `stagedAt` values. State copy mirrors the confirm path's vocabulary
  (expired :4715, version-dead :4729-4732) reworded for a reader: "…run the freeze again
  in chat for a fresh plan." `pinnedCount` = exact `===` against `PINNED_SKIP_REASON`.
  Weekday via `weekdayLabel` (import from `../schedule/fit.js`). Do NOT include
  `confirmId`/row id in the view — the page must not leak a confirm handle.

**`src/mcp/server.ts`**
- Confirm branch :4713: replace inline `12 * 3600_000` with `FREEZE_PROPOSAL_TTL_MS`.
- `boardMiniAppLink(param?: string)` :1226-1240: optional param, validated
  `/^[a-z0-9_-]{1,64}$/`, appended as `?startapp=<param>`.
- Decoration seam :5454-5478: keep the `needs_confirmation` exclusion; add the narrow
  branch — `toolName === 'run_freeze' && status === 'needs_confirmation'` ⇒ attach
  `proposalLink: boardMiniAppLink('freeze')` + the fused line under the field name
  **`boardNote`** (the committed-result idiom) — NEVER `note`: the stage result already
  carries `note` (:4689-4696) and the seam's spread lands after the result (:5468-5477),
  so a `note:`-named attachment would silently clobber the stage instruction (review
  finding 1). Fused text: `ALWAYS end this reply with the exact line: [Review the full
  proposal on the board](<link>)`. Handle unset ⇒ attach nothing (existing behavior).

**`src/telegram/boardApi.ts`**
- `GET /board/api/freeze-proposal` (after `/board/api/roster`, bucket pattern :275-287):
  auth → manager-only 403 → `findOpenReviewItemsByKind(tenantId, 'pending_freeze')` +
  `latestScheduleVersion(tenantId)` (`src/db/scheduleEvents.ts:40`) →
  `projectFreezeProposal(...)` → `json(res, 200, view)`.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` (727 passed, 2026-07-27)
- [ ] boardApi.test.ts new suite: 401 unauthenticated; 403 technician; `none` (no token);
      `open` (hand-built `stagedDetail` fixture via `upsertOpenReviewItem` +
      `updateOpenReviewItemDetail`, matching server.ts:4656-4662 shape) asserting weekday
      on every placement, exact `pinnedCount`, `expiresAt = stagedAt + 12h`, and NO
      `confirmId`/id in the body; `expired` (backdated stagedAt); `stale` (bookVisit after
      staging bumps the version); malformed ⇒ `none`; two open tokens (two subjects) ⇒
      newest wins.
- [ ] server.test.ts: stage result carries `proposalLink` ending `?startapp=freeze` + the
      fused `boardNote` line **AND the stage `note` ("NOTHING is booked yet…") survives
      alongside it — asserted WITH `BOARD_BOT_HANDLE` set in the test** (unset ⇒ no
      decoration ⇒ a clobber would ship invisibly, review finding 1); a DIFFERENT staged
      tool's result still carries no board fields (seam exclusion intact); the committed
      `run_freeze` result still carries `boardLink`; confirm-path expiry still enforced
      (existing test passes with the shared constant).

### Live verification (agent-executable) — deferred to Phase 3 rollout. 
### Manual — none.
---

## Phase 2: Board client — pill, sheet, deep-link routing

### What this phase does
Client only (no server change): header pill, read-only proposal sheet, `start_param` boot
routing. board.js is a plain no-build script — behavior verification is Phase 3's live E2E
+ the owner's phone pass; this phase's automated gate is lint + the endpoint contract
already pinned in Phase 1.

### Changes required

**`web/board/board.js`**
- Header pill (manager-only, beside `bucket-pill` :335-340): async fetch post-paint
  (`bucket` idiom :497-512) of `/board/api/freeze-proposal`; render "Freeze proposal" pill
  ONLY when `state === 'open'` (expired/stale/none ⇒ no pill).
- `openProposal()`: re-fetch on open (never stale, `openBucket` idiom :620-705); render via
  `openSheet`/`sheetShell` (:1016-1040): non-`open` states ⇒ the served `message` + nothing
  else; `open` ⇒ sections — **Placements** grouped by date (weekday + date header; rows
  `HH:MM–HH:MM · customer · title · tech`), **Skipped** (label + reason verbatim),
  **Capacity** (per tech, minutes formatted by the existing duration formatter), **pin
  line** ("N pinned visit(s) left untouched"), footer hint: "To confirm: reply *yes* to
  the assistant in chat — this page can't book anything." Reuse `.bucket-section`/
  `.bucket-row` vocabulary; server strings verbatim; no client date math beyond the served
  weekday.
- Boot (:1998-2029): after first render, if manager tier and
  `tg.initDataUnsafe.start_param === 'freeze'` (fallback: the `tgWebAppStartParam` query
  param, read via **`window.location.search`** — eslint's `web/**/*.js` block declares
  only `window/document/fetch/setTimeout/clearTimeout/Telegram` globals with `no-undef`,
  so bare `location`/`URLSearchParams` fails the lint gate, review finding 3) ⇒
  `openProposal()`. Technician tier ⇒ ignore (endpoint 403s anyway; the sheet would only
  show an error — don't open it).

**`web/board/board.css`**
- `.freeze-pill` (bucket-pill twin) + minimal proposal-section styles; respect
  `prefers-reduced-motion` (sheet already does, :242-261).

### Automated verification
- [x] `npm run lint` (board.js is in the lint gate) · full gates re-run (727 passed, 2026-07-27;
      phase review: no correctness findings, 1 reuse fix folded — openSheet/sheetShell)
### Live/manual — deferred to Phase 3 rollout (the board only exists deployed).
---

## Phase 3: Chat-copy shrink + resolve_review rider + rollout

### What this phase does
The three copy homes shrink, the rider lands, docs sync, then the full rollout + E2E.

### Changes required

**`src/mcp/server.ts`**
- Stage-result note :4689-4696 (the strongest lever — fused instruction): "NOTHING is
  booked yet. Give the manager a SHORT summary only — counts (placed / skipped / pinned
  untouched) plus the one or two most consequential skips — and end with the proposal
  board link line. If NO board link is present, show the ENTIRE plan instead. Booking
  happens only after the manager's explicit yes (then call again with ONLY confirmId)."
- `run_freeze` description :850-865: replace "Show the manager ALL of it…" with the
  summary-first contract (same wording family as the note).
- `resolve_review` description :876-890 (rider, live-E2E finding): lead generic — resolved
  = handled, dismissed = not an issue / **cancel it**; add: "For staged proposals (e.g. a
  pending freeze): dismissed CANCELS the proposal — the chat way to kill it before its
  expiry; resolved is refused (confirm via the staging tool)." Keep the pairing sentences
  after. Handler unchanged (`STAGED_ACTION_KINDS` :5353-5369 already enforces).

**`Box_Setup_Stuff/bootstrap-box.sh`** §0h :810-831 (refreshable, delete-then-append)
- Item 1 becomes: show the SHORT summary (counts + notable skips + pin line) and ALWAYS
  relay the proposal board link line; **no link ⇒ show the entire proposal as before**.
  Items 2–3 (human-yes-only, cron = proposal + STOP, §0g rules) unchanged.

**`docs/nemoclaw-tech-agent.md`** — sync the freeze-ritual bullet (Box Setup Stuff sync
rule: same-change update).

### Automated verification
- [ ] full gates; server.test.ts copy pins updated (stage-note wording, descriptions)
- [ ] `npm run build` before the PR

### Rollout + Live verification (agent-executable; prerequisites: merged + deployed,
`supabase-test` MCP, s2 CLI probe, ssh to trades-box-1)
- [ ] Deploy freshness: served board.js byte-identical to main (recurring check).
- [ ] Fleet gateway restarts s2/s3/s5/s7/s8 (description changes) + WIRE pass ×5 (§0h);
      verify grep per sandbox (freeze-ritual block carries the new summary contract).
- [ ] s2 probe: stage-only `run_freeze` → the chat reply is a SHORT summary ending with
      the exact proposal-link line (no full table); SQL read-back: token open. Then
      dismiss via chat (`resolve_review` — the rider's live retest: the agent should find
      the lever UNAIDED this time); read-back: token dismissed, zero schedule writes.
- [ ] Expiry-state probe (cheap): backdate the dismissed... skip — expired/stale states
      are pinned by Phase-1 tests; live retest not required.

### Manual verification (owner's phone)
- [ ] The pill appears while a proposal is open; tapping it renders the sheet and the
      content matches the SQL plan read-back.
- [ ] The chat link opens the board straight onto the proposal sheet.
- [ ] The shrunken chat message + sheet together read better than the old table (the
      original complaint — the acceptance bar).
---
*Pause after Phase 3 for the owner's phone pass; plan flips complete on it.*
