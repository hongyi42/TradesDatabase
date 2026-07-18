---
date: 2026-07-17
task: "Feature A (FOUNDATION) — technician-optional bookings + reversibility-driven confirmation policy"
research: thoughts/shared/research/2026-07-17-feature-A-technician-optional-bookings-and-confirmation-policy.md
status: draft
---

## Overview
Two pilot-driven fixes to the DB-owned schedule. **Fix 1:** let a visit be booked with **no
technician attached** ("put it on the calendar, assign later"). **Fix 2:** draw the confirmation
boundary on **reversibility + customer promise**, not on history — reversible/unpromised schedule
ops act in one shot, a customer-promise-affecting op still confirms, and the irreversible seat mint
(`add_technician_seat`) gains a confirmation. Also stop confirming the server's 2-hour end-time
guess. This is the foundation the concurrent Telegram-board feature builds on, so the verb/reader
seams are kept intact.

## Decisions
- **Unassigned representation → nullable `technician_id`** (not a sentinel roster row). Chosen: it is
  the cheaper schema change, matches an existing precedent (`sandbox_pool.technician_id` is already a
  nullable FK), and its one downside — the `no_confirmed_overlap` exclusion guard stops covering
  unassigned rows — is *semantically correct* (there is no technician to double-book). The sentinel
  option's downside (two unassigned visits sharing the sentinel key would **falsely** collide) is a
  real bug we'd have to code around, plus it needs seat-cap and `resolveTechnician` carve-outs.
- **Bookable technician states unchanged.** `invited`/`pending_verification`/`active` stay bookable;
  `offboarding`/`offboarded` stay rejected (`isInactiveState`). The pilot gap was "*any* technician
  required," not "invited was wrong" — the null path solves it; `technicians.ts` is untouched.
- **Seat-less named part-timer → deferred; "assign later" reuses `move_visit`.** The null-technician
  booking IS the v1 "assign later" primitive; attaching a person = `move_visit` with a `technicianRef`
  (same day/time). A named seat-exempt person (new column/trigger carve-out) and an `assign_visit`
  tool are out of scope; a named part-timer occupies a seat like anyone else for now.
- **Confirmation doctrine (USER DECISION 2026-07-17): confirm only what is irreversible or
  externally visible; everything reversible just happens — and the agent says what it did.**
  The concrete marker for "externally visible" in the schedule is the customer promise: a
  promised booking/move/cancel drives what the customer will actually experience (someone shows
  up on the day they were told, or doesn't), so an error there is customer-visible; an unpromised
  one is internal and undo is one more command. Mapping: book/move/cancel act **one-shot** when
  nothing was promised (`promiseLevel==='none'` / `promiseBroken===false` / cancel of an
  unpromised visit) and the agent reports the result; they keep the existing stage→confirm token
  when a promise is at stake. `add_technician_seat` (irreversible: permanent never-reused ref +
  burned seat) gains a stage→confirm token (`pending_seat_add`), mirroring `pending_deactivation`.
  The rest of the surface already conforms (send/record/retract = irreversible L1 writes →
  confirmed; reads → never).
- **2-hour default: fix the input path, don't script the server.** Agent instruction to pass an
  explicit `endTime` when the manager states one (AGENTS.md), plus an additive `endTimeDefaulted`
  flag on the book preview/result so the agent can disclose the assumed length. No server-authored
  verbatim sentences (respects the rejected-PR-#44/#45 decision: keep agent voice free-form).

## Plain-language walkthrough
A **booking** is one row: a job × (a technician) × a time window. Today three layers force a
technician onto every booking, and every schedule change is confirmed the same way a permanent
email is — while adding a paid roster seat sails through with no confirmation at all.

```
Fix 1  book_visit(no technicianRef) → assignment.technician_id = NULL
        get_team_schedule shows it flagged  {unassigned:true}   ← manager sees "needs assigning"
        move_visit(assignmentId, technicianRef) later attaches a person

Fix 2  reversible + nothing promised  → DO IT NOW (one call, report back)
       customer was promised a day/time → STILL stage → show preview → yes → commit
       add_technician_seat (irreversible) → NOW stage → show minted ref → yes → commit
```

- **Phase 1** makes the verbs + DB accept a null technician (migration drops `NOT NULL`; the verbs
  branch when nobody is named). You'd notice it by `bookVisit` succeeding with no `technicianRef` in
  a unit test, and the double-booking guard correctly *not* firing between two unassigned visits.
- **Phase 2** exposes it through the agent: `book_visit` no longer requires `technicianRef`, and
  `get_team_schedule` labels person-less rows `unassigned:true`. You'd notice the board showing a
  booked-but-unassigned stop.
- **Phase 3** flips book/move/cancel to one-shot when nothing was promised (and adds the
  `endTimeDefaulted` flag); a *promised* change still asks for a yes. You'd notice "book Jane
  internal" returning `booked` immediately, while "book Jane, I told them Tuesday" still previews.
- **Phase 4** gives `add_technician_seat` the two-step it lacked and moves the agent instructions
  (bootstrap `AGENTS.md` block + `docs/nemoclaw-tech-agent.md`) so the live agent's behavior matches.
- **Phase 5** ships it: pilot migration, Render deploy, and the two agent-side cache refreshes
  (gateway `tools/list` restart + on-box AGENTS.md hand-sync) — without these the live bots keep the
  old "technician required / always confirm" behavior no matter what merged.

## Secrets & env preflight
- **Phases 1–4:** `DATABASE_URL` + Supabase local-stack vars in `.env.test` (`already required`,
  per CLAUDE.md — tests run only against the local Docker stack; `testEnvGuard` enforces it). No new
  secrets. Key-gated live-model tests are skipped without `.env` and are not needed here.
- **Phase 5:** `mcp__supabase-test__*` MCP (already connected — migration apply + read-backs on the
  pilot), Render dashboard access (Deploy latest commit), and trades-box-1 SSH (gateway restarts +
  AGENTS.md sync). No new secrets; nothing touches prod.

## Phase 1: Nullable technician on the verbs + DB

### What this phase does
Drop `assignments.technician_id NOT NULL`, regenerate the type, and teach `createAssignment` /
`resolveBooking` / `resolveMove` / `availabilityWarning` to handle "nobody attached." Codebase stays
working: the MCP tool still requires a ref, so no user-visible change yet.

### Changes required
**`supabase/migrations/20260717120000_technician_optional_bookings.sql`** (NEW)
- `alter table assignments alter column technician_id drop not null;` with a comment explaining the
  FK + `no_confirmed_overlap` exclusion both simply don't apply to NULL rows (desired: no technician
  → nothing to double-book). Nothing else changes.

**`src/db/database.types.ts`**
- Regenerate against the LOCAL stack after applying the migration
  (`npx supabase gen types typescript --local` — **never** hosted). Net effect: `assignments`
  `technician_id` becomes `string | null` in `Row` (~L50), `Insert` (~L66), `Update` (~L82). If the
  local CLI is unavailable, hand-edit those three occurrences to `string | null`.

**`src/db/assignments.ts`**
- `CreateAssignmentInput.technicianId: string` → `string | null` (L22). Insert already reads
  `input.technicianId` → add `?? null` at L43 for the null path.
- `rescheduleAssignment` L162: `technicianId: input.technicianId ?? old.technician_id` now yields
  `string | null` — flows into the widened `createAssignment`. No other change (RescheduleInput
  keeps `technicianId?: string`).
- **New `listUnassignedAssignments(tenantId, fromISO): Promise<Assignment[]>`** — the recall
  surface for "assign later" visits (and Plan 3's future work queue): `status='confirmed'`,
  `technician_id IS NULL`, `starts_at >= fromISO`, ordered by `starts_at`. No upper date bound —
  the whole point is catching visits parked beyond any board window. (Unassigned visits drop out
  of `listUnassignedOpenJobs` — their job HAS a live assignment — so without this they are
  findable only inside a ≤14-day `get_team_schedule` query.)

**`src/schedule/booking.ts`**
- `BookVisitInput.technicianRef: string` → `technicianRef?: string` (L116). `ResolvedBooking.technician:
  Technician` → `Technician | null`; `BookVisitPreview.technicianRef/technicianName` → `string | null`.
- `resolveBooking` (L143): `const technician = input.technicianRef ? await resolveTechnician(...) : null;`
  Skip the overlap pre-check and availability advisory when `technician === null`
  (`const clashes = technician ? await overlappingConfirmed(technician.id, …) : []`; warning only when
  technician present). `createAssignment({ technicianId: r.technician?.id ?? null, … })` at L263.
- `previewBookVisit` echoes `technicianRef: r.technician?.ref ?? null`, `technicianName:
  r.technician?.display_name ?? null`.
- `resolveMove` (L346): guard the no-ref branch so `getTechnicianById` never sees null —
  `input.technicianRef ? resolveTechnician(...) : old.technician_id ? getTechnicianById(old.technician_id, tenantId) : null`.
  `const targetTechnicianId = technician?.id ?? old.technician_id;` (`string | null`); overlap
  pre-check only when `targetTechnicianId` is non-null.

**`src/schedule/booking.test.ts`** (extend)
- `bookVisit` with no `technicianRef` on the `customerId` path → confirmed row, `technician_id` null,
  preview `technicianRef:null`.
- Two unassigned confirmed visits at the same time both succeed (guard does not fire — the semantic
  point of Decision 1).
- `moveVisit` attaching a technician to a null-technician row (`technicianRef` given) → new row has
  that `technician_id`; overlap now enforced against that technician.
- `listUnassignedAssignments`: returns only confirmed null-technician rows from `fromISO` onward
  (assigned rows, cancelled rows, and past rows excluded), ordered by `starts_at`, with no upper
  date bound (a row months out is returned).

### Automated verification
- [x] `npx supabase migration up` (local) applies cleanly (ledger `20260717120000`, column
      `is_nullable=YES` read back); `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm test` passes, incl. the new `booking.test.ts` cases (481 passed / 1 skipped; 16/16 in
      booking.test.ts — unassigned book, no-false-collision pair, attach-re-engages-guard, lister)
- [x] `npm run build` passes
- Adversarial review (fresh subagent): NO FINDINGS — consumer sweep confirmed identityMatch/
  daySource are structurally null-blind; edge cases verified against the live GiST constraint.
- Note: one type-compat line pulled forward from Phase 2 (`server.ts` null-safe `techById.get`) —
  declared, behavior identical for non-null rows.

---

## Phase 2: Expose technician-optional booking through the MCP tool + readers

### What this phase does
Let the agent book with no technician and label person-less rows on the board.

### Changes required
**`src/mcp/server.ts`**
- `book_visit` STAGE branch (L2153–2156): drop `if (!technicianRef) throw`. Pass
  `...(technicianRef ? { technicianRef } : {})` into `previewBookVisit`; keep `date` required.
- Stage `detail` (L2190): store `technicianRef: technicianRef ?? null`. CONFIRM malformed guard
  (L2235): remove `!d.technicianRef` from the check (a null ref is a valid unassigned booking; still
  require date + startTime + endTime + exactly one of customerId/jobId). CONFIRM call to `bookVisit`:
  `...(d.technicianRef ? { technicianRef: d.technicianRef } : {})`.
- `get_team_schedule` stop object (L2116): add `unassigned: row.technician_id === null` (keep the
  existing `technicianRef`/`technicianName` null echo).
- **`get_team_schedule` gains `unassignedOnly?: boolean` (the cheap lister — NOT a new tool, so no
  tool-count churn in docs/tests):** when true, skip the 14-day cap and the `to` bound entirely —
  read `listUnassignedAssignments(tenantId, fromISO)` (from defaults to firm-local today), bucket
  by day into the SAME response shape (every stop `unassigned:true`), still return
  `scheduleVersion`. The normal path (arg absent/false) is byte-for-byte unchanged.
- Tool descriptions (L536–545 book_visit; L519–525 get_team_schedule): technicianRef "optional —
  omit to book WITHOUT a technician (put it on the calendar, assign later); attach one later with
  move_visit"; get_team_schedule note that `unassigned:true` stops need a person and that
  `unassignedOnly:true` lists ALL upcoming visits with nobody attached, however far out — use it
  when the manager asks what still needs assigning.

**`src/mcp/server.test.ts`** (extend the scheduling describe ~L2972)
- `book_visit` staged + confirmed with **no** `technicianRef` → `booked`, and a follow-up
  `get_team_schedule` shows the stop with `unassigned:true`, `technicianRef:null`.
- `move_visit` on that unassigned assignment with a `technicianRef` → `moved`, board now shows the
  person and `unassigned:false`.
- **Recall-surface case (the finding this lister fixes):** an unassigned visit booked ~3 weeks out
  is ABSENT from a default `get_team_schedule` read but PRESENT with `unassignedOnly:true`; an
  assigned visit never appears in the `unassignedOnly` view; a >14-day from/to WITHOUT
  `unassignedOnly` still errors (cap unchanged on the normal path).

### Automated verification
- [x] `npx tsc --noEmit` passes
- [x] `npm run lint` passes
- [x] `npm test` passes incl. the new server cases (483 passed / 1 skipped; unassigned book→board→
      attach + unassignedOnly recall/cap/type-guard cases)
- [x] `npm run build` passes
- Adversarial review (fresh subagent): no code findings; one scope catch — the preflight
  `supabase/config.toml` restore was unstaged, committed separately as `dde677d`.

---

## Phase 3: Reversibility-gated confirmation for book / move / cancel

### What this phase does
book/move/cancel act one-shot when no customer promise is at stake; keep the existing stage→confirm
token when one is. Add the `endTimeDefaulted` disclosure flag.

### Changes required
**`src/schedule/booking.ts`**
- Add `endTimeDefaulted: boolean` to `ResolvedBooking` (`input.endTime === undefined`), surface it on
  `BookVisitPreview` and `BookVisitResult`. Pure additive; no behavior change in the verb.

**`src/mcp/server.ts`** — restructure only the STAGE branch of each tool (CONFIRM branches unchanged):
- `book_visit`: after `previewBookVisit`, if `preview.promiseLevel === 'none'` → **one-shot**: call
  `resolveOpenReviewItemFor('pending_booking', subjectRef, 'dismissed', 'superseded')` (drop any
  stale token), then `bookVisit(resolved args incl. preview.startTime/endTime/promiseLevel)` and
  return the same `{status:'booked', …, endTimeDefaulted, unassigned:booked.assignment.technician_id===null}`
  shape as the confirm branch. Else (`day`/`time`) → stage exactly as today.
- `move_visit`: if `!preview.promiseBroken` → one-shot `moveVisit`; else stage as today (the promise
  warning is exactly what the manager must confirm).
- `cancel_visit`: `previewCancelVisit` returns `promiseLevel`; if `=== 'none'` → one-shot `cancelVisit`;
  else stage as today (cancelling a promised visit means someone must tell the customer).
- Update the three tool descriptions (L536, L563, L585): "Reversible and internal (nothing promised
  to the customer) → done in one call — ALWAYS tell the manager what was done (day, time, who, and
  any warning); never act silently. If the customer was promised a day/time, you get
  {needs_confirmation, confirmId} + preview — show it, get a yes, call again with only confirmId."
  book_visit description: "pass endTime explicitly whenever the manager states an end time."

**`src/mcp/server.test.ts`**
- Update the existing `promiseLevel:'none'` book case (~L3131) to expect one-shot `booked` (no
  `needs_confirmation`); keep the `promiseLevel:'day'` case (~L3004) asserting stage→confirm.
- Move: unpromised move → one-shot `moved`; a `promiseBroken` move (move a `day`-promised visit to a
  new day) → `needs_confirmation` then `moved` with `promiseBroken:true`.
- Cancel: unpromised → one-shot `cancelled`; cancel of a `day`-promised visit → stage→confirm.
- Assert `endTimeDefaulted:true` when `endTime` omitted, `false` when passed.

### Automated verification
- [x] `npx tsc --noEmit` / `npm run lint` / `npm test` / `npm run build` all pass (483 passed / 1
      skipped)
- [x] new + updated scheduling tests cover: one-shot unpromised path (book/move/cancel + "one step"
      notes), retained-confirm promised path (walkthrough), `endTimeDefaulted` both ways on the
      one-shot path AND the confirm path (stage-time-truth pin added post-review)
- Adversarial review (fresh subagent): NO FINDINGS. One real bug caught by the new tests
  pre-review: the one-shot return read the verb's recomputed `endTimeDefaulted` (always false,
  since commit passes the resolved endTime) — fixed to stage-time truth (`preview.endTimeDefaulted`,
  mirroring the confirm branch's staged copy).

---

## Phase 4: Confirm the irreversible seat mint + move the agent instructions

### What this phase does
Give `add_technician_seat` the same stage→confirm token the other admin mutations have, and update
the agent-facing instructions so the live bot's behavior matches both fixes.

### Changes required
**`src/db/reviewItems.ts`**
- Add `'pending_seat_add'` to the `ReviewKind` union (L10–22).

**`src/mcp/server.ts`** — `add_technician_seat` handler (L2508):
- Two-step, subject-keyed to the caller (`subjectRef = identity.technicianRef`, same idiom as
  book_visit). STAGE (no `confirmId`): validate `displayName`, mint `ref = slugify(...)` (keep the
  empty-slug error), stage-time dup pre-check (`getTechnician(tenantId, ref)` exists → throw "ref
  taken"), `resolveOpenReviewItemFor('pending_seat_add', subjectRef, 'dismissed', 'superseded')`,
  `upsertOpenReviewItem({kind:'pending_seat_add', subjectRef, detail:{ref, displayName, tier,
  stagedAt}})`, return `{status:'needs_confirmation', confirmId, preview:{ref, displayName, tier},
  note about consuming a seat + minting a permanent ref}`.
- CONFIRM (`confirmId` only): `getOpenReviewItem(confirmId, tenantId, {kind:'pending_seat_add',
  subjectRef})` → 15-min expiry → **consume-first** `resolveReviewItem('resolved')` → `insertTechnician`.
  On insert failure translate `isSeatCapError`/`isUniqueViolation` and `annotateResolvedReviewItem`
  (token already consumed — the send_email idiom). Return the roster row on success.
- Tool description (L421–426): "manager only — **two-step** (mints a permanent ref + burns a seat,
  not reversible): first call returns {needs_confirmation, confirmId, preview}; confirm with only
  confirmId."

**`Box_Setup_Stuff/bootstrap-box.sh`** — extend the `§0c` AGENTS.md block (541–574; the appended
here-doc). Add behavioral bullets (free-form voice, no scripted server sentences):
- The confirmation rule, in general: confirm only what is irreversible or externally visible
  (a customer promise at stake). Everything reversible — just do it, then SAY WHAT YOU DID
  (day, time, who, any warning); never act silently and never ask permission for a reversible
  internal change.
- Scheduling verbs (book/move/cancel) are REVERSIBLE: when the change is internal (nothing promised
  to the customer) the server acts in one call — report the result. When the server returns
  `needs_confirmation`, a customer was promised a day/time (or a promise is breaking): show
  the preview, get an explicit yes, confirm with only `confirmId`.
- `add_technician_seat` is now two-step (permanent ref + a seat): stage, show the minted ref, get a
  yes, confirm with only `confirmId`.
- Always pass an explicit `endTime` to `book_visit` when the manager states an end time — never let
  the server's 2-hour default stand in for a stated time. When a length wasn't stated and you rely
  on the default, say so (the result's `endTimeDefaulted`).
- Note in the plan for the implementer: the on-box s2/s3 `AGENTS.md` were hand-edited 2026-07-15 and
  the template-sync PR was rejected — after editing the template, re-sync the live boxes by hand
  (Box Setup Stuff sync rule) so a `rebuild` doesn't regress.

**`docs/nemoclaw-tech-agent.md`**
- Update §4/§5 confirmation notes: the 4 scheduling tools now confirm only on a customer-promise;
  `add_technician_seat` is two-step. (Keep in lockstep with bootstrap-box.sh per the sync rule.)

**`src/mcp/server.test.ts`** — update the seat tests (~L444–530):
- `add_technician_seat` first call → `needs_confirmation` + `confirmId` + `preview.ref`; second call
  with `confirmId` → the roster row (no seat consumed until confirm — assert the row count before
  confirm). Keep the seat-cap and duplicate-ref cases (cap can surface at confirm; dup at stage).

### Automated verification
- [x] `npx tsc --noEmit` / `npm run lint` / `npm test` / `npm run build` all pass (483 passed / 1
      skipped; `bash -n` on bootstrap-box.sh clean)
- [x] seat two-step test: nothing is inserted until the confirming call (SQL row-count pin);
      forged `confirmId` mints nothing; dup at STAGE; cap at CONFIRM (stage returns
      needs_confirmation — cap not pre-checked); freed seat usable via fresh stage→confirm;
      offboarding suite's cap-filler seats converted to two-step (missed call site caught by
      the suite itself)
- Adversarial review (fresh subagent): ONE finding, fixed + re-verified — the stage return
  echoed local state instead of the ITEM's staged detail (racing stages could show carl-sagan
  while the token mints bob-marley, on the irreversible tool); now echoes `item.detail` per the
  send_email/book_visit idiom. Also added (small plan gap): `pending_seat_add` joins
  `resolve_review`'s live-token refusal list. Verified clean: offboarded refs DO block at the
  stage dup pre-check (getTechnician is state-blind, matching the all-rows unique constraint);
  tier forgery impossible (validated at stage, guarded lookup, DB enum backstop).

### Manual verification
- [ ] none this phase — the live Telegram E2E runs in **Phase 5** (it needs the deployed pilot +
      refreshed agent caches; running it before deploy would test the OLD tool surface).

---

## Phase 5: Deploy gate — pilot rollout + live-agent cache refresh

### What this phase does
Ships Phases 1–4 to the pilot. **Without this phase the fixes are invisible in production**, for
three separate cache reasons: (1) the pilot DB lacks the nullable-column migration; (2) Render runs
the old code until an explicit deploy; (3) the live agents keep the OLD tool descriptions
("technicianRef is required", always-stage semantics) because each sandbox's **gateway caches
`tools/list` per process** — only a gateway restart refreshes it — and the on-box `AGENTS.md` files
are hand-maintained copies that a template edit alone does not touch.

### Changes required
None to repo files — Phases 1–4 hold all code/doc changes. This phase is rollout, in this order
(migration BEFORE code: the old code never writes a null `technician_id`, so a null-tolerant schema
under old code is safe; new code against the un-migrated schema would surface NOT-NULL insert
errors to the manager):

1. **Merge via PR** (standing rule — no direct push to main; "you may commit" ≠ "you may push").
2. **Apply the migration to the pilot:** `mcp__supabase-test__apply_migration` with the Phase-1
   SQL (`technician_optional_bookings`). Read back the ledger.
3. **Render web redeploy** — Manual Deploy → **"Deploy latest commit"** (recorded gotcha: the
   "Redeploy" button rebuilds the OLD commit). Cron needs no change this feature.
4. **Gateway restart on every active sandbox** on trades-box-1 (`nemoclaw <sandbox> gateway
   restart`, one per active seat — currently the manager's, Judy's, and any claimed pool seat).
   This is what refreshes the cached `tools/list` so the agents see the new descriptions. Never
   health-check or poke via `nemoclaw <name> agent` — it injects into the live Telegram session
   (recorded hazard).
5. **AGENTS.md live sync:** hand-apply the Phase-4 §0c bullets to each live sandbox's `AGENTS.md`
   (the on-box s2/s3 copies were hand-edited 2026-07-15 and drift from the template — a template
   edit alone regresses on the next rebuild, and a live edit alone regresses the template). Also
   refresh the box's **installed** `bootstrap-box.sh` copy (`/usr/local/sbin`) — the recycler
   provisions future sandboxes from the installed copy, so a stale one would mint new seats with
   the old confirmation instructions.

### Automated verification
- [ ] full gates pass on the merge commit (`npm run typecheck` / `lint` / `test` / `build`)

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test__*` MCP (read-backs + the migration apply), Render dashboard
  access, box SSH. Follow the `verifying-behavior` skill for the cross-channel checks.
- [ ] pilot ledger shows the new version (`list_migrations` read-back)
- [ ] `select is_nullable from information_schema.columns where table_name='assignments' and
      column_name='technician_id'` on the pilot → `YES` (`execute_sql` read-back)
- [ ] post-restart `tools/list` read-back from a sandbox gateway shows the new `book_visit`
      description (technicianRef optional) — per the sandbox-tool-allowlist recipe
- [ ] E2E via the manager agent, with SQL read-back as cross-channel evidence:
      "just book it, no tech" → one-shot `booked`, pilot row has `technician_id IS NULL`,
      `get_team_schedule` shows `unassigned:true`; then `move_visit` attaching a person →
      row re-created with that technician

### Manual verification
- [ ] Telegram E2E on the real device (absorbs Phase 4's deferred check): "add a seat for X" →
      exactly one confirmation then the ref; "book 9–10" → agent passes the explicit endTime, no
      confirm-the-guess; a *promised* move still asks for a yes. Capture the chat.
- [ ] **Pilot manager told about the behavior flip** (they are live-using `book_visit` as of
      2026-07-17): internal/unpromised bookings no longer ask for a yes — the agent just does it
      and reports (undo = move/cancel); changes touching a customer promise still confirm.
      Confirm the wording reads naturally to a non-engineer.

---
*Pause after Phase 5 for the manual checks and the pilot-facing communication; Phases 1–4 are fully
covered by automated + codified checks and the implementer continues through them.*

## File footprint
Creates/modifies (the parallel-vs-stacked comparison list):
- `supabase/migrations/20260717120000_technician_optional_bookings.sql` (new) — Phase 1
- `src/db/database.types.ts` — Phase 1
- `src/db/assignments.ts` — Phase 1
- `src/schedule/booking.ts` — Phase 1 + Phase 3
- `src/schedule/booking.test.ts` — Phase 1
- `src/mcp/server.ts` — Phases 2, 3, 4
- `src/mcp/server.test.ts` — Phases 2, 3, 4
- `src/db/reviewItems.ts` — Phase 4
- `Box_Setup_Stuff/bootstrap-box.sh` — Phase 4
- `docs/nemoclaw-tech-agent.md` — Phase 4

Considered but **not** modified: `src/db/technicians.ts` (`isInactiveState`/states unchanged) and
`src/routes/daySource.ts` / `get_schedule` (per-technician view; unassigned rows are correctly
invisible there — `get_team_schedule` is the surfacing).

Phase 5 touches **no repo files** (rollout only), so this footprint — and the parallel/stack
comparison below — is unchanged by it.

## Assumptions
Recorded because this is a non-interactive planning pass (no user to confirm with):
- Chose **nullable `technician_id`** over the sentinel row (Decision 1) on the trade-offs above.
- ~~Chose promise-gated confirmation as the planner's reading~~ **Ratified by the user
  (2026-07-17): "confirm only what's irreversible or externally visible; everything reversible,
  just do — and say what you did."** Promise-at-stake is the agreed concrete marker for
  "externally visible"; the implementation reuses the already-computed
  `promiseLevel`/`promiseBroken` (today text-only). The `moveVisit` non-atomic-stranding caveat
  is retained by the verb's honest UNSCHEDULED error, which the one-shot path still surfaces.
- **`add_technician_seat` gains a confirm** (Decision 6) and the 2-hour fix is the input-path/AGENTS.md
  approach (Decision 5b + an additive `endTimeDefaulted` flag), NOT server-authored sentences
  (honors the rejected-PR-#44/#45 decision).
- Seat-less *named* part-timer and a dedicated `assign_visit`/un-assign tool are **out of scope**;
  the null booking + `move_visit` reassignment cover the pilot's "assign later" need.
- The adversarial plan-review step is normally a spawned subagent; without the Task tool I
  self-reviewed against every file touched (line anchors, null-key overlap-guard behavior, the
  confirm-branch malformed guard, and that the existing `promiseLevel:'none'` server test must flip
  to one-shot). No blocking gaps; the live agent-stack E2E is the only deferred check.
- Did **not** run the app, tests, seeding, or any DB write; the migration applies to the LOCAL stack
  only and types regenerate from `--local`.

## Parallel/stack verdict (plan-two)
**Recommendation: STACKED — land Feature A first, then re-check/rebase Feature B.**

**Reasoning.** Exact-path file intersection is empty, but the plans are semantically coupled through
the schedule **per-stop shape** and the **schedule column type**, so parallel implementation carries a
real merge-time interaction risk:
- Feature A Phase 1 drops `assignments.technician_id NOT NULL` and Phase 2 rewrites the
  `get_team_schedule` per-stop object (adds `unassigned: technician_id === null`; person-less rows now
  resolve `technicianRef`/`technicianName` to null). Feature B's new `src/schedule/boardRead.ts` is a
  hand-copy of that exact body (server.ts:2091-2143) and its technician self-view filter
  (`technician_id === viewerTechnicianId`) is written against a NOT-NULL column. Built in parallel on
  today's foundation, B's copy would silently omit A's `unassigned` field and mishandle null-technician
  rows — a stale-duplicate divergence that a textual merge cannot catch.
- B insulates its **write** path by calling the `booking.ts` verbs directly (fork (b)), and A's
  `booking.ts` changes are additive (`endTimeDefaulted`, nullable `technicianRef`, `previewCancelVisit`
  gains `promiseLevel`), so B's verb callers survive. This is the one place the coupling is *already*
  mitigated — but the read-shape coupling above is not.
- The `technicians.ts` worry B raised is **moot**: A's final plan leaves `technicians.ts` and
  `isInactiveState` untouched (A's Decision 2 + footprint), so B's new global-lookup functions and their
  `isInactiveState` call are unaffected. This is why there is no exact-path conflict — but it does not
  make the features independent, because the shape coupling above still stands.

Stacking is cheap here: B is explicitly designed to stack (its Decision "STACKED after Feature A"),
centralizing the coupled shape in one module (`boardRead.ts`) + `board.js`'s render, so only those need
re-checking once A lands and its per-stop shape is fixed.

**Shared files (exact-path intersection): none.** Semantic coupling travels through *different* files:
A edits `src/mcp/server.ts` `get_team_schedule` + adds the nullable-technician migration; B duplicates
that read shape in new `src/schedule/boardRead.ts`. Both touch `src/db/technicians.ts` only in the sense
that B adds functions there and A does not (no conflict).

**Risk areas.**
- `src/schedule/boardRead.ts` (B, new) is a copy of `get_team_schedule`'s per-stop shape that A rewrites
  (adds `unassigned`, null `technicianRef`/`technicianName`) — must be rebased onto A's final shape.
- `assignments.technician_id` nullability (A's migration): B's board read/filter/render must handle
  null-technician (unassigned) rows — self-view filter, manager-view label, `board.js` technicianName.
- Confirm-model divergence: A moves book/move/cancel to one-shot-unless-promised in `server.ts`; B drives
  writes via `booking.ts` verbs directly, so verify B's in-UI preview→confirm still matches the promise
  semantics A leaves in the verbs (additive only — low risk, but re-check `previewMoveVisit`/`previewCancelVisit`).
- Sequencing: B's live E2E additionally needs Plan 1 Phase-5 pilot rollout (backfill + Render redeploy),
  still unchecked — a rollout prerequisite, orthogonal to A.
