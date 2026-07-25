---
date: 2026-07-25
task: Cancel vocabulary — rename cancel_visit → unschedule_visit; add cancel_job (terminal, always confirmed)
research: none (decision session 2026-07-25; facts verified against main in-session)
status: draft
---

## Overview

"Cancel" currently means the weaker thing in our vocabulary: `cancel_visit` takes one calendar
attempt off the schedule while the WORK survives and returns to the loose bucket. The stronger
meaning — "we're not doing this work at all" — has **no verb**: the only job-status writers on
main are the inbound-email extractor (`src/writePath/recordFieldNote.ts:225`) and a booking-race
rollback (`src/schedule/booking.ts:382`). A manager saying "they called it off" in chat ends
with a cancelled visit and a zombie job in the bucket — which the 4b-3 freeze would then
*place*. This plan renames the weak verb to what it does and adds the missing strong one.

**Sequencing (user, 2026-07-25): this lands BEFORE PR #79.** It branches off `main` (no 4b-1
dependency), merges first, then #79 rebases (overlap is limited to the `server.ts` tool array
and small `boardApi.ts`/`board.js` regions). One combined deploy + fleet gateway restart covers
both — the restarts were owed for #79 anyway.

## Decisions

- **Vocabulary** (user, 2026-07-25) — `cancel_visit` → **`unschedule_visit`** ("off the
  calendar; the job returns to the loose bucket"); new **`cancel_job`** ("the work is off;
  leaves the bucket; remaining visits come off the calendar"). After this, *cancel* appears in
  exactly one tool name and always means the final thing. "Unschedule" reads as family with
  the established "unassign" (remove the person) — remove the calendar slot.
- **Confirmation via the existing doctrine, no new rule** (user asked for confirmation "due to
  blurriness"; the vocabulary makes the doctrine deliver it) — `cancel_job` is **terminal** in
  the job state machine (`ALLOWED_TRANSITIONS`, `src/db/jobs.ts:19`: `cancelled → []`), so the
  irreversible-→-confirm rule (PR #48) makes it **always confirm**. `unschedule_visit` stays
  promise-gated exactly as today (reversible: one-shot unpromised, confirmed when promised).
  Explicitly rejected: confirming unpromised unschedules — that re-adds the friction the
  doctrine removed, and the blur is gone once the word is gone.
- **Ambiguity goes to the human** — both tool descriptions carry the same steering line: if the
  manager's words could mean either ("cancel the Hendersons"), ASK which; never guess.
- **Storage vocabulary unchanged** — `assignments.status` enum value `'cancelled'`,
  `schedule_events.kind 'cancelled'`, and the `/board/api/cancel` path all stay. The ledger is
  append-only history (existing rows can't be rewritten), both `kind` columns are plain text
  (verified: `20260702194603…sql:59`, `20260714120000…sql:34` — **no migration anywhere in
  this plan**), and the endpoint is internal wire, not agent-facing vocabulary. Surface +
  exported-function names are what rename (the Parked→Unassigned precedent).
- **`cancel_job` is chat-only in v1** — the Telegram agent is the product surface; a board
  button can follow demand. The board's existing visit-cancel affordance just re-copies to
  "Unschedule".
- **Cascade order: visits first, job last** — each live (confirmed/proposed) visit is
  cancelled with its own ledger event (existing `'cancelled'` push copy in
  `src/telegram/boardNotify.ts:99` fires per visit, so affected technicians hear), then the job
  flips, then one `job_cancelled` event. A crash mid-cascade leaves a re-runnable state (job
  still open); completed/terminal visit rows are never touched (their transitions are illegal
  anyway).
- **The staging idiom is reused, not invented — including its keying** (plan-review finding):
  `pending_visit_cancel` (`src/mcp/server.ts:3165-3260` on main) keys the token on the CALLER
  (`subjectRef = identity.technicianRef`), which is what gives per-caller supersede and
  only-the-stager-confirms. `cancel_job` mirrors that exactly: kind `'pending_job_cancel'`,
  **subjectRef = the caller's ref, jobId rides in the staged detail** — not subjectRef=jobId,
  which would silently drop both properties. `review_items.kind` is text — no migration.
  Staged-token continuity across the rename is safe: confirm resolves by id+kind+subjectRef
  (all unchanged) and tokens hard-expire at 15 minutes anyway.
- **`cancel_job` joins `BOARD_LINK_TOOL_NAMES`** (`src/mcp/server.ts:1043` — mislabelled as a
  "tier array" in an earlier draft; tier membership actually comes from placement in
  `ADMIN_TOOLS`/`MANAGER_TOOLS`). Its result changes what the board shows, and the recorded
  live incident behind that set is an agent fabricating a URL when a schedule answer carried
  no link.
- **Docs ride the same change** — `docs/nemoclaw-tech-agent.md:101,126` name `cancel_visit`;
  the Box Setup Stuff sync rule applies (update both in this PR). `docs/doorman-runbook.md:331`
  is a dated historical log line — left as history, new dated line appended.

## Plain-language walkthrough

```
 what the manager means            the verb (after this plan)
 ───────────────────────           ─────────────────────────────────────────
 "do it at a different time"   →   move_visit            (unchanged)
 "not THIS attempt — the           unschedule_visit      (renamed; visit off the
  work still needs doing"           calendar, job back in the loose bucket)
 "we're not doing it at all"   →   cancel_job            (NEW; terminal, always
                                                          asks you to confirm)
```

**Phase 1** is the rename. Nothing behaves differently — the tool, the code functions, the
board button, and the agent docs all switch from "cancel" to "unschedule" for the visit-level
action, and the descriptions say plainly that the job comes back to the bucket. You'd notice it
as the board button reading "Unschedule" and the assistant using the new word.

**Phase 2** adds `cancel_job`. The assistant can finally act on "they called the whole thing
off": it shows you what dies — the job, plus each upcoming visit with any promise the customer
holds — and commits only on your yes. The job leaves the loose bucket, so the future freeze
never schedules dead work. You'd notice it by cancelling a job in chat and watching it vanish
from the tray.

**Phase 3** is the rollout order: this merges to main first, #79 rebases on it, one deploy, one
fleet restart, then the live probes for both PRs run together.

## Secrets & env preflight

- **Phases 1–3:** none. Phase 3 needs the `supabase-test` MCP + s2 chat access (already used
  this session). `npx supabase start` for every phase's tests (CLAUDE.md).

---

## Phase 1: The rename — unschedule_visit

### What this phase does

Renames the visit-level verb everywhere a human or the agent sees it, with zero behaviour
change. Line references are against **main** (this branch forks from main).

### Changes required

**`src/schedule/booking.ts`**
- Rename exports (grep-driven, tsc-checked): `CancelVisitInput` → `UnscheduleVisitInput`
  (:614), `CancelVisitPreview` → `UnscheduleVisitPreview` (:621), `previewCancelVisit` →
  `previewUnscheduleVisit` (:629), `cancelVisit` → `unscheduleVisit` (:649). Internal ledger
  event kind `'cancelled'` and `updateAssignmentStatus(…, 'cancelled', …)` stay (storage).

**`src/mcp/server.ts`**
- Tool def (:723): name → `unschedule_visit`; description rewritten to say (a) the visit comes
  off the calendar and **the job returns to the loose bucket** — the work is NOT cancelled;
  (b) for "the customer called the whole thing off" use `cancel_job`; (c) the ambiguity
  steering line ("cancel the Hendersons" → ASK which). Handler `case 'cancel_visit'` (:3165)
  → `'unschedule_visit'`, including the restage error text (:3229).
- Update every cross-reference: the `BOARD_LINK_TOOL_NAMES` entry (:1047), `update_job`'s
  description (:885), the one-shot booked note (:2831), and `STAGED_ACTION_KINDS` inside
  `case 'resolve_review'` (:4601 — the map VALUE becomes `unschedule_visit`; the stored kind
  `pending_visit_cancel` stays, existing staged rows must keep resolving).
- Result copy inside the handler: replace "cancelled" phrasing with "unscheduled — the job is
  back in the loose bucket" so the survival of the work is stated in every reply.

**`src/telegram/boardApi.ts`**
- Imports and call sites (:16, :20, :501, :508) follow the renames. The path
  `/board/api/cancel` (:303, :499) stays (internal wire; recorded decision).

**`web/board/board.js`**
- User-visible copy only: the ✕ button aria-label (:162) → "Unschedule visit"; `cancelFlow`
  (:1416) toasts/copy → "Unschedule"/"Unscheduled — back in the loose bucket"; the promised-
  visit dialog wording likewise. Form-internal `data-form="cancel"` (Cancel/Save buttons) is
  untouched — that's the dialog-dismiss sense of cancel, a different word entirely.

**`Box_Setup_Stuff/bootstrap-box.sh` (:594, :619)** — **the severe plan-review finding**: two
heredoc template blocks (the confirmation doctrine and the boardLink contract) name
`cancel_visit` and are **delete-then-appended into every agent's AGENTS.md on each wire run** —
the template-refresh mechanism would re-stamp the dead name into fleet agents' instructions on
every run, and no code gate would ever notice. Rename in both blocks. (The dir is
`Box_Setup_Stuff` — underscores.)

**`docs/nemoclaw-tech-agent.md`** (:101, :126) — rename in the living tool lists; the Box
Setup Stuff sync rule is satisfied by the bootstrap-box.sh edit above landing in the same
commit. `docs/doorman-runbook.md`: append a dated vocabulary-change line; leave :331's
2026-07-14 entry as history.

**Test files** — rename sites are bounded (review-counted): `src/mcp/server.test.ts` ×8 (note
:3413 asserts `toContain('cancel_visit')` and :3430/:3493 assert result copy — the "loose
bucket" rewrite changes those beyond a pure rename), `src/schedule/booking.test.ts` ×5,
`src/telegram/boardNotify.test.ts` ×3, `boardApi.test.ts` ×0 (it drives the unchanged wire
path and storage status).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] rename completeness gate:
      `grep -rn "cancel_visit\|cancelVisit\|CancelVisit" src web Box_Setup_Stuff` returns
      **zero** hits (docs keep only the historical runbook line)
- [ ] existing cancel tests (renamed) pass unchanged in behaviour: one-shot unpromised,
      staged+confirmed promised, terminal-row refusal, board preview/commit parity
- [ ] new assertion: the `unschedule_visit` one-shot result text contains "loose bucket"

### Live verification (agent-executable)
Deferred to Phase 3 (nothing deployed until the combined rollout).

### Manual verification
None.

---
*No Manual items — continue straight to Phase 2.*

## Phase 2: cancel_job — the missing strong verb

### What this phase does

Adds the terminal verb: preview shows the job and every live visit (with promises), commits
only on confirmation, and the job leaves the loose bucket.

### Changes required

**`src/schedule/booking.ts`** — the deterministic core (every surface calls these):
- `previewCancelJob(tenantId, jobId)`: tenant guard is **explicit** — `getJob` is id-only
  (plan-review finding: no `getJobForTenant` exists, and `listAssignmentsForJob` /
  `updateAssignmentStatus` / `updateJobStatus` are all id-only too), so the guard is
  `if (!job || job.tenant_id !== tenantId) throw new Error('job not found')` — the
  `updateJobIdentity` idiom — and every cascade step operates only on rows reached through
  that guarded job. Refuse terminal jobs with the state-machine vocabulary
  (`ALLOWED_TRANSITIONS` — only `open`/`in_progress` may cancel);
  load live visits via `listAssignmentsForJob` (`src/db/assignments.ts:380`) filtered to
  confirmed/proposed; return `{ jobId, jobTitle, customerName, visits: [{assignmentId, day,
  startTime, promiseLevel, technicianRef}], requiresConfirmation: true }` — **always true**
  (terminal ⇒ the doctrine's confirm arm; single-sourced on the preview like every other
  requiresConfirmation).
- `cancelJob({tenantId, jobId, reason, actorRef})`: re-validate exactly as preview; cancel
  each live visit (`updateAssignmentStatus(id, 'cancelled', reason)` + a `'cancelled'` ledger
  event each — the existing boardNotify copy pushes to affected technicians); then
  `updateJobStatus(jobId, 'cancelled')` (guarded transition — a concurrent flip surfaces);
  then one `job_cancelled` schedule event (`detail: { jobId, reason, visitsCancelled: n }`;
  new kind = plain text, no migration; produces no push — the manager initiated it).

**`src/mcp/server.ts`**
- New tool `cancel_job` (manager tier — add beside `unschedule_visit` in the tier array):
  description states it is TERMINAL ("there is no un-cancel; a revived job is a new job"),
  always requires confirmation, removes the job from the loose bucket, unschedules its
  remaining visits (promises disclosed in the preview), and carries the shared ambiguity
  steering line.
- Handler: mirror the `pending_visit_cancel` staging body (:3165-3260 idiom) with kind
  `'pending_job_cancel'`, **subjectRef = `identity.technicianRef`** (the caller — preserves
  per-caller supersede and only-the-stager-confirms; the jobId rides in the staged detail):
  stage → return the preview + confirmId; confirm → consume token, `cancelJob`, report what
  died (job + per-visit list). Add the kind to `STAGED_ACTION_KINDS` (:4601) as `cancel_job`,
  and `cancel_job` to `BOARD_LINK_TOOL_NAMES` (recorded decision).

**`src/db/reviewItems.ts`** (plan-review finding — missed footprint): the `ReviewKind` union
(:10-27) gains `'pending_job_cancel'`, or the `upsertOpenReviewItem` call does not compile.

**`Box_Setup_Stuff/bootstrap-box.sh` (:594)** — the confirmation-doctrine template block says
"Scheduling verbs (book_visit / move_visit / cancel_visit) are REVERSIBLE"; after this phase
that sentence is **wrong**, not just stale: `cancel_job` is terminal and always confirms. Add
its doctrine line ("cancel_job is TERMINAL — always confirm; there is no un-cancel") alongside
the rename.

**`docs/nemoclaw-tech-agent.md`** — add `cancel_job` to the tool lists.
**`Box_Setup_Stuff/doorman-architecture-memory.md` (:268) and
`doorman-nemoclaw-setup-guide.md` (:24)** — the manager tool catalog names the verbs and pins
the count "34" → becomes 35 (operator-doc drift the review counted; fix while there).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] `src/schedule/booking.test.ts`: cascade cancels confirmed+proposed visits and flips the
      job; a **completed** visit row is untouched; terminal jobs (`paid`, `cancelled`) refuse
      with the transitions message; preview lists each live visit's promiseLevel; ledger holds
      n×`'cancelled'` + 1×`job_cancelled`
- [ ] `src/mcp/server.test.ts`: `cancel_job` NEVER commits one-shot (even a visit-less,
      promise-free job stages); confirm consumes the token and the job leaves
      `get_team_schedule`'s recall + the bucket read; technician badge denied; unknown/
      cross-tenant jobId → not found; restage supersedes a prior pending token
- [ ] `src/telegram/boardApi.test.ts`: `/board/api/bucket` no longer lists the cancelled job
      (pins "leaves the bucket")

### Live verification (agent-executable)
Deferred to Phase 3.

### Manual verification
None.

---
*No Manual items — continue straight to Phase 3.*

## Phase 3: Rollout — before #79, one restart cycle

### What this phase does

Lands the vocabulary first, then lets 4b-1 ride the same deploy.

### Changes required

**No source files.** Order:
1. PR for this plan → review → merge to main (**user merges**).
2. Rebase #79's branch on main; re-run the full gates; push (#79 stays open for its own merge).
   **Expect real conflicts in `src/mcp/server.ts`** (plan-review finding): #79 rewrites the
   `update_job` description whose final line is a Phase-1 rename target (:885), and edits the
   booked-note lines adjacent to :2831 — resolve by hand, then re-run the rename-completeness
   grep on the rebased branch, because a wrong resolution inside a description string passes
   typecheck and tests silently.
3. After both merge: **one** deploy; byte-compare the served `/board/static/board.js` against
   main (Render "Redeploy" reuses the OLD commit — recorded trap); **one** fleet gateway
   restart pass (cached `tools/list` hides both PRs' tool changes until then).
4. Touch up `thoughts/shared/plans/2026-07-24-plan-4b2-unplaced-visits.md` where it cites
   `cancel_visit`/`previewCancelVisit` names (doc-only). *This file exists only on #79's
   branch, so this step necessarily runs after #79 merges — the ordering above already
   guarantees that.*

### Automated verification
- [ ] post-rebase, on #79's branch: `npm run typecheck` · `npm test` pass (the integration
      gate for the combined diff)
- [ ] post-rebase, on #79's branch:
      `grep -rn "cancel_visit\|cancelVisit\|CancelVisit" src web Box_Setup_Stuff` → zero hits

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; s2 chat via `nemoclaw s2 agent`; deployed board.
- [ ] From live chat: unschedule a probe visit → the reply says the job is back in the loose
      bucket; SQL read-back shows assignment `'cancelled'`, job still `'open'`. **Evidence:**
      chat + row.
- [ ] From live chat: `cancel_job` the probe job → a confirmation is demanded; confirm; SQL
      read-back shows job `'cancelled'` and it is absent from `/board/api/bucket`.
      **Evidence:** chat exchange + row + bucket payload. (This doubles as pilot cleanup —
      run it on a probe job minted for the test.)
- [ ] Phase 2/3 live probes from the 4b-1 plan run in this same pass (they were deferred to
      post-deploy there).

### Manual verification
- [ ] The board's visit sheet shows "Unschedule" (not "Cancel") on the manager's phone
- [ ] USER: merge order honoured (this PR → #79) — the gate is human by nature
