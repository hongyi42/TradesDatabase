---
date: 2026-09-02
task: "Build 6.5 — one generalized `send`: the planner chooses who to talk to, and a message need not be about a gap"
research: thoughts/shared/research/2026-09-01-one-send-verb.md
status: draft
supersedes: nothing
---

**`supersedes:` is not optional bookkeeping.** This plan overturns no earlier document. It
COMPLETES one: `docs/engineering-memory.md` §6a entry 6.5 records the ruling and the probed
ground, and build 6 (landed `569cae6`) deleted `escalate` on the explicit promise that this build
replaces it. The research was conducted on `main` @ `48288a4`, BEFORE build 6 — every `[B6]`
marker in it has now landed, so quote the code, not the research.

## Overview

After build 6 the planner has seven verbs and can reach exactly two places, both chosen for it by
the record: the gap's person, and that person's assistant. Every decision must carry a gap id,
enforced in four layers ending at a database CHECK. `escalate` was the only verb reaching a human
the gap does not name, and it is gone.

This build gives it one `send(to?, as, message, about?, countsAsTheAsk?)` reaching anyone on the
roster by either route, about a gap or about nothing. Verbs go **7 → 5**: `send`, `hold`, `close`,
`dismiss`, `recover`. Re-asking — deferred out of build 6 by ruling (2026-09-02) — arrives as a
consequence of the collapse rather than as machinery of its own.

## Decisions

- **One verb absorbs three** (user ruling 2026-09-01). `send`, `ask_agent`, `inform_agent` become
  `send` with `as: 'chat' | 'assistant'`. The seat-side tools (`inform_team_lead`, `ask_team_lead`,
  `inform_teammate`) are the INBOUND half, untouched — the 17/46/47 counts do not move.
- **Both legs, and the chat leg costs no box change** (user 2026-09-02). Verbatim-to-a-phone
  exists today but ONLY as a gap: the text lives in `nudges.question`, so the gap row is the
  envelope. Verified while planning: `nudge-runner.sh:93-101` reads only
  `id/sandboxRef/replyTo/directMessageB64` and never names a table; `httpServer.ts:321-330`
  uuid-checks the reported id and nothing more; the office host embed already carries
  `telegram_user_id` (`officeMessages.ts:139-140`). A gap-less chat message therefore rides the
  EXISTING runner — no `Box_Setup_Stuff` sync, no s2 roll.
- **`countsAsTheAsk` is a flag the planner sets** (user 2026-09-02), not derived. The silent-lever
  cost is answered by a rail, not a default: a chat send to a gap's OWN person ABOUT that gap must
  state the flag either way, and its ABSENCE is refused. Detected with `'countsAsTheAsk' in d`,
  never `?? false` — a provider that drops false-valued keys would otherwise make the rail inert
  (the `notBefore` absent-vs-null precedent, `planner.ts:1876-1885`).
- **A named person only, no role token** (user 2026-09-02: "the planner can just send the same
  message to all three"). `notifyManagers` stays the call worker's. Several sends per tick already
  work — gap-less sends are not keyed by the `seen` set.
- **`to` is OPTIONAL and defaults to the gap's person.** Post-review change: requiring a copied ref
  on every ordinary gap ask would regress the most-used verb and orphan four corpus expectations,
  for no gain. Absent `to` = today's behaviour exactly.
- **The planner is shown a roster** so a `to` is COPIED from a list, never invented. It carries
  per-person reachability, and the predicate is what the TRANSPORTS require, not what rank someone
  holds: both legs need a HOST and a sandbox (every delivery starts from a host pull filtering
  `technicians.host_id` — `nudges.ts:192`, `officeMessages.ts:158`), and chat needs the Telegram
  binding on top. Corrected after the Phase 1 review, which caught the claim omitting `host_id`.
- **The roster is firm state, not an addressing aid** (user 2026-09-02: "if the planner is the
  central intelligence of the firm, it should know the roster of the team actively"). What exists
  today is a per-gap `person: <display name>` line (`buildGapView`) — so the planner knows the
  people who currently have problems and nobody else, and knows them by a name it cannot address.
  `v_team` has always been in its `spine_read` catalog (`server.ts:772`), so this was never a
  gate, only an absence. Consequence taken here: the gap view also prints the person's REF beside
  the name, for the reason the same function already prints a job id beside the customer name —
  *"Without it the planner searched with `customer_name LIKE '%Okafor%'` and burned turns on
  queries that returned nothing — it had the words but not the key"* (`planner.ts:125-128`).
  Exactly the same trap, one field over.
- **A gap whose person has LEFT must say so** (user 2026-09-02: "if it was working on a gap which
  belonged to someone who used to belong to the roster but not anymore, the planner should
  actively adjust"). Verified: offboarding a seat does NOTHING to that person's open gaps — no
  code path cancels, reassigns or flags them — and `technicianName` is a SNAPSHOT stamped into
  `context` at detection time (`watchers.ts:609`, `:675`), never refreshed. So today the gap keeps
  showing a departed person's name with no hint, a `queued` one freezes silently at the
  `isInactiveState` skip (`nudgeQueue.ts:131-133`), and an `asked` one waits forever for an answer
  from somebody who is gone, ageing into `asksUnattended`. The planner cannot fix any of it,
  because the only person it can reach is the one on the gap. **6.5 is what makes it fixable** —
  ask somebody else about the same gap — so the departure must become visible in the same build.
  NOT by auto-cancelling on offboard: build 5 removed the sweep's authority to end gaps, and
  reinstating it here as a trigger would re-make that mistake. Tell the planner; let it judge.
  (User, confirming: *"It's good that you did not try to auto-cancel the person's gap because I
  think the planner should be flexible enough to handle this type of situation."*)
- **A FULL ROSTER TRAIL, not just a departure date** (user ruling 2026-09-02, choosing between the
  two: *"the planner should probably have a record of the firm's roster (with history) … so it
  doesn't have to go looking for record that proves a person was offboarded"*). New
  `roster_events` table — joined / left / came back, and when. `technicians.updated_at` is bumped
  by ANY edit, so it can never answer "when did they leave", and **the trail cannot be
  backfilled** — it starts empty, and a departure predating it renders `date unknown`, never a
  guess.
- **CAPTURED BY A DATABASE TRIGGER, and `actor_ref` stays empty** (user ruling 2026-09-02, after
  the plan's premise was found false at implementation time). This plan first said state changes
  "funnel through ONE function, `setTechnicianState`", and hooked it app-side to carry the actor.
  **`setTechnicianState` has NO production runtime callers** — only the test suite and two scripts
  (`scripts/seed.mjs:266`, `scripts/spine-eval/world.mjs:388`). Every real
  transition goes through `casTechnician` (`server.ts:5444` deactivate, `:5540` reactivate,
  `:7905` pairing-verified, `composio/pairing.ts:123,291`, `composio/offboarding.ts:86`) or
  `updateTechnician` (`server.ts:5745`), both of which take a patch OBJECT — which is why a grep
  for an inline `state:` literal missed them, and `casTechnician`'s own comment says so outright:
  *"Every lifecycle transition goes through this."* The planned design would have produced a trail
  that is FULL IN TESTS AND EMPTY IN PRODUCTION — the worst failure available, because every test
  would have proved it working. A trigger catches all four writers and any fifth added later.
  The cost, accepted: a trigger cannot see WHO acted, and no mechanism exists to pass one down
  (`spine.tenant_id`, this codebase's only session setting, is set inside SQL and has no
  TypeScript caller). `actor_ref` stays a nullable column, always empty, so attribution can be
  added later without redesign.
- **Departures are shown only when a gap names them.** The roster block lists everyone reachable
  plus any departed person the tick's own gaps mention. An unbounded alumni list would grow
  forever and spend context every tick on people nobody is asking about; `v_roster_events` is
  there for the rest.
- **THE BRIEFING CARRIES A SUMMARY, NOT THE TRAIL** (user ruling 2026-09-02, asked directly
  whether the planner sees the whole history: *"Leave it as it is"*). Three layers, and only the
  third reaches the model: `roster_events` STORES every transition forever; a tick READS events
  only for people who are both departed AND named by an open gap; and one DERIVED date is
  rendered (`currentDeparture` — the start of the departure that still stands). Everything else —
  who joined when, who left and came back, a seat that churned — is a `spine_read` on
  `v_roster_events` the planner makes when it wants it. **Accepted cost, named at ruling time:** a
  gap's evidence lines carry technician refs, so a note written by somebody who has since left
  reads as though they are still around; only the person the gap's `technician_id` points at gets
  the departure line.
- **The block's SHAPE was rewritten after the user read the first draft** (2026-09-02: "This
  doesn't seem very readable"). The draft was a three-column table whose columns did not align —
  names vary in width — carrying jargon ("chat, assistant") in a document that is otherwise
  `key: value` lines and plain sentences. Now one short line per person, a second indented line
  ONLY for somebody a message cannot fully reach, and departures as sentences. Header is
  `THE TEAM`, not `WHO YOU CAN REACH`.
- **Gap-less sends stay in `decisions` with `nudgeId` optional**, not a second `messages` array —
  the model should not pick a container before it picks an act.
- **A gap-less decision IS recorded in `nudge_decisions`** (subject CHECK relaxed, `to_ref`/`via`
  added). That log is the corpus the evals read. **Invariant:** a gap-less decision writes
  `job_id: null`, because `listDecisionsForJob` (`nudgeDecisions.ts:227-243`) selects on `job_id`
  alone and `recall_decisions` maps `gapId: r.nudge_id ?? r.observation_id` (`server.ts:5884`) —
  a job-stamped gap-less row would reach the model with a null gap id.
- **RE-ASK IS A MESSAGE, NOT A RE-QUEUE — the design changed after review.** The plan first said
  re-ask = widen `markNudgeQueued`'s pending-only guard. Three verified facts kill that:
  (1) `nudge-runner.sh:115-118` re-acks any id carrying a `sent-<id>` marker and SKIPS the send;
  markers are never removed, so a re-queued nudge reports delivered while nobody is texted —
  a false "no box change"; (2) `markNudgeAsked`/`markNudgeAskedGroup` (`nudges.ts:254-256`,
  `:343-350`) write `asked_at` unconditionally on `queued → asked`, so a re-ask would re-anchor
  the `asksUnattended` alarm AND the evidence floor (`planner.ts:2734-2736`, `asked_at ??
  created_at`), silently dropping older evidence out of the gap's own block; (3) a former group
  member re-asked alone keeps its `ask_group_id`, whose lead is now `asked`, so
  `buildNudgeDelivery` finds no lead and freezes it forever (`nudgeQueue.ts:98-142`).
  **Instead:** a gap that is already `asked` stays asked, and asking again is an ordinary chat
  message about it (`countsAsTheAsk` illegal on an asked gap — it is already the ask). New uuid, so
  no marker collision; `asked_at` untouched; no group to freeze; no `markNudgeQueued` change at
  all. This is also the thesis of the build — the list is a suggestion, and a second ask is a
  message, not a state change.
- **`asked_at` means FIRST asked** and nothing in this build re-anchors it.
- **No `nudge_decisions_action_check` amendment** — actions only SHRINK (verified against the live
  CHECK), and build 6 proved deletion needs no migration.
- **No `v_office_messages`.** `SPINE_VIEW_CATALOG` is shared with `query_spine` (`server.ts:757`),
  so publishing it would hand every manager the planner's outbound message bodies. The briefing
  block is the planner's read; a view is an evaluation-phase decision with a disclosure question
  attached.
- **Two cheap concessions to build 8, taken now** (review finding). The ambiguity rail expresses
  its addressee test as a single predicate `gapNames(view, addresseeId)` rather than an inline
  equality, so build 8 widens a set instead of unpicking a rail, a refusal string, the doctrine
  and four tests. And `office_messages` gains a nullable `message_group_id` in this build's
  migration — free now, a backfill-over-live-rows problem later — so "one message, several people"
  has an identity when build 8 needs one.
- **Accepted limit, recorded not fixed:** a firm with no open gaps AND no unread messages is
  skipped before planning (`planner.ts:2646-2650`), so the planner cannot message anyone at a
  totally quiet firm, and build 6's recover-only tick stays unreachable. Un-skipping means a model
  call per cadence tick per firm forever, to say something that in practice always accompanies
  something else on the list. Belongs to the evaluation phase.
- **Out of scope:** `as: 'board'` (the only leg reaching a seatless manager, but one-way,
  unrecorded, token found unset Aug 2026; `as:` is the extension point); several addressees on one
  message (build 8); the `review_items` rename (after build 7, by ruling).

## Plain-language walkthrough

**Phase 1 — the firm's roster.** The planner is never told who works at the firm. It sees gaps,
each naming its own person by a name stamped in when the gap was found and never refreshed. This
phase gives it the team: who is here, who can be reached and how, and — because a roster row is
never deleted — who used to be here and when they left. Nothing about messaging changes yet. You
would notice it when a gap belonging to somebody who left says so instead of showing their name
as though nothing had happened.

**Phase 2 — who you can reach.** Knowing the team is not the same as being able to address it.
This phase lets the planner put a name on the two message verbs it already has, so a message can
go to somebody the gap does not mention. After it, the planner can reach a manager for the first
time since build 6 deleted `escalate`.

**Phase 3 — a message need not be about a gap.** Four layers insist every decision carries a gap
id, the last a database rule. This phase makes the id optional for messages and mandatory for the
four verbs that act on a gap. You would notice it when the decision log first shows a row with no
gap and a person's name instead.

**Phase 4 — one verb.** Three verbs collapse into one, and the second delivery leg opens.

```
send(to?: "manager-sam", as: "chat", message: "...", about?: gap, countsAsTheAsk?: bool)
     │
     ├─ countsAsTheAsk: true ──► the GAP path (nudges row) — the question of record.
     │                            Legal only on a gap not yet asked, to a person it names.
     └─ otherwise ─────────────► an office_messages row, `via` = as
           via 'chat'      → served by the EXISTING nudge pull → openclaw message send
           via 'assistant' → served by the office pull         → openclaw agent (silent turn)
```

Asking again falls out of this for free: a gap already asked stays asked, and the second ask is
just another chat message about it.

**Phase 5 — seeing what you sent.** A planner that can ask again needs to see that it asked and
heard nothing. This phase adds the outbound side of its briefing, an age line on asked gaps, and
rewrites the doctrine around five verbs and two legs.

## Secrets & env preflight

- **Phases 1-5:** none. Every key is already required (`SUPABASE_*`, the model provider). No new
  external service. `BOARD_BOT_TOKEN` is explicitly NOT needed — `as: 'board'` is out of scope.

## Phase 1: The firm's roster

### What this phase does
Gives the planner the team: who is here, how each of them can be reached, and — because a roster
row is never deleted — who used to be here and when they left. No verb, schema or delivery change.

### Changes required

**`supabase/migrations/20260903110000_roster_events.sql`** (new)
- `create table roster_events (id uuid pk, tenant_id uuid not null references tenants(id),
  technician_id uuid not null references technicians(id), from_state text, to_state text not null,
  actor_ref text, reason text, occurred_at timestamptz not null default now())`, indexed
  `(tenant_id, occurred_at desc)` and `(technician_id, occurred_at desc)`.
- APPEND-ONLY by intent, not by trigger — no updater is written and none should be.
  `from_state` is nullable: the first event for a pre-existing person cannot know what came
  before, and a NULL there means "we started watching here", never "they came from nowhere".
- **The trail starts empty and cannot be backfilled** — `technicians.updated_at` is bumped by any
  edit (a skills change, a phone binding) so it is not a departure date. The roster block must
  therefore say `left (date unknown)` for anyone whose departure predates this table, never guess.
- RLS deny-all + `revoke all from anon, authenticated` (the `office_messages` posture,
  `20260901150000`), and `create view v_roster_events` with the standing
  `where tenant_id = current_setting('spine.tenant_id')::uuid` predicate plus
  `grant select on v_roster_events to spine_reader` (the `v_nudges` posture, `20260823120000:121-123`).
- DEPLOY ORDER header: apply BEFORE the code.

- **The capture is a TRIGGER, not an app-side write** (see Decisions — `setTechnicianState` has no
  production runtime callers and the production paths are
  `casTechnician`/`updateTechnician`):
  `after insert or update on technicians for each row`, writing an event when `tg_op = 'INSERT'`
  (`from_state` null — "we started watching here") or when
  `new.state is distinct from old.state`. Columns take the `technician_state` ENUM, not text, so
  a bad value cannot land. No app-side writer is added anywhere.

**`src/db/technicians.ts`**
- New `listRosterEvents(tenantId, technicianIds)` — bounded by ids, never a tenant scan. This is
  the ONLY change to this file; no existing function is touched, which is the point of the
  trigger.

**`src/teamLead/planner.ts`**
- `interface Addressee { ref: string; technicianId: string; displayName: string; tier: string;
  state: TechnicianState; chat: boolean; assistant: boolean; leftAt: string | null }` and
  `buildReachableBlock(team: Technician[], departures: Map<string, string>): string` rendering
  `THE TEAM — copy a name exactly when you write to somebody.` plus one line per non-inactive row:
  `  <ref>  <display_name>  <tier>  — chat, assistant | assistant only (no phone linked) |
  UNREACHABLE (schedule only)`. `chat` = `sandbox_ref && telegram_user_id`; `assistant` =
  `sandbox_ref`; `seat_exempt` or `isInactiveState` → neither. Skills/cities are NOT printed.
- **Departures are listed only when a gap in front of the planner names them**, under
  `NO LONGER HERE`: `  <ref>  <display_name> — left <date>` (or `date unknown`). Bounded by the
  tick's own gaps on purpose — a firm with turnover would otherwise grow an alumni list forever
  and spend context every tick on people nobody is asking about.
- **`PlannerDeps` gains `listTeam?: typeof listTeam`** and `listRosterEvents?` (`:510` region),
  resolved the way every other reader is (`:2456-2485`). Non-negotiable: a live `listTeam('t1')`
  is a PostgREST 22P02 that turns every planner unit test into a `tenantError`
  (`planner.ts:538-540` records the standing reason).
- `runPlanner`: build `Map<string, Addressee>` from the roster, keyed by BOTH ref and
  `technician_id`; pass it through to `buildGapView`.
- **The map holds EVERY row, not just the reachable ones** — offboarded and seat-exempt included
  (`chat: false, assistant: false`, with `state`), or the gap view cannot tell "left the firm"
  from "never existed".
- `buildGapView`'s person line gains the REF and CURRENT standing, resolved live by
  `technician_id` rather than trusting the snapshot in `context` (so a rename resolves too):
  - `person: Ben Shelton (ben-shelton)` — reachable both ways
  - `person: Judy Ramirez (judy-ramirez) — assistant only, no phone linked`
  - `person: Joy Nguyen (helper-joy) — no assistant and no phone; nobody to ask here`
  - `person: Ben Shelton (ben-shelton) — NO LONGER ON THE TEAM, left 12 Aug`
  - `person: unknown` unchanged when the context names nobody.

**`src/mcp/server.ts`** — `SPINE_VIEW_CATALOG` (`:760`) gains `v_roster_events`, and the
"thirteen views" count becomes fourteen. Both pinned: `server.test.ts:8287` (`toContain('thirteen
views')`) and `querySpine.test.ts:317` (an EXACT array of the views `spine_reader` may select).
Unlike office-message bodies, a firm's own roster history is data its managers already own, so
sharing the catalog with `query_spine` is acceptable — record that acceptance the way
`v_observations`' was.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [x] migration applies to the local stack and is re-runnable (run it twice)
- [x] new: the trigger appends exactly one `roster_events` row per state change, carrying the
      previous state; an update that does NOT change state appends nothing; inserting a
      technician appends one row with `from_state` null
- [x] new: **the trigger fires for `casTechnician` AND `updateTechnician`, not just
      `setTechnicianState`** — this is the finding that changed the design, so it gets its own
      test naming all three paths. Without it the suite would pass on the test-only helper while
      production wrote nothing.
- [x] new: `buildReachableBlock` renders all four reachability states, omits offboarded rows from
      the reachable list, and lists a departure ONLY when a gap names that person
- [x] new: a gap whose person is `offboarded` renders `NO LONGER ON THE TEAM`; one whose person is
      seat-exempt renders `nobody to ask here` — both from the roster, NOT from the stale
      `technicianName` in `context`
- [x] new: a gap whose person was RENAMED since it was minted renders the CURRENT name
- [x] new: a departure with no `roster_events` row renders `date unknown`, never a guess
- [x] the two view-count pins updated: `server.test.ts:8287`, `querySpine.test.ts:317`

### Live verification (agent-executable)
- Prerequisites: local Supabase stack (`npx supabase start`, `.env.test`), `npm run seed:local`
- [x] Offboard a seeded technician who holds an open gap through the real tool path, then drive one
      tick and read the RENDERED user message back: the gap must say `NO LONGER ON THE TEAM` with
      the date, and `roster_events` must hold the `active → offboarded` row. Cross-channel: the
      prompt text and the table, not one inferred from the other.

### Manual verification
- [x] The roster block reads like something a person would write, and leaks nothing a manager
      would not want the planner repeating

---

## Phase 2: Who you can reach

### What this phase does
Lets the planner put a name on the two message verbs it already has. Verb list, schema shape and
delivery paths unchanged.

### Changes required

**`src/teamLead/planner.ts`**
- `validateDecisions` (`:1406`): new param `reachable: Map<string, Addressee> = new Map()` (built
  in Phase 1). In the office-verb branch accept optional `to` — absent → unchanged behaviour;
  present → refuse if unknown ("names somebody who is not on the list you were given"), refuse if
  `!assistant` with the honest reason, refuse if they have LEFT (naming the departure, since Phase
  1 makes that visible and a message to a departed person reaches nobody). Carry `toRef` /
  `toTechnicianId` on `PlannerDecision`.
- **The two `!technician_id` guards must yield to an explicit `to`**: the validate rail at
  `:1566-1573` ("the record names no person for it") and the apply guard at `:2381`
  (`if (!n || !n.technician_id) return refused`). With `to` naming a manager, a gap that names
  nobody is no longer a reason to refuse.
- `applyDecision` (`:2360`): address the resolved person when `toRef` is set.

**`src/teamLead/plannerPrompt.ts`** — `SUBMIT_PLAN_TOOL` (`:328`) gains `to`: "the person this
message goes to, ref copied exactly from THE TEAM. Leave it out to reach the gap's own
person."

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] new: `to` naming an unknown ref is REFUSED, with the ref in the detail
- [ ] new: `to` naming a seat-exempt person is REFUSED before any write
- [ ] new: `to` naming somebody who has LEFT is REFUSED, naming the departure
- [ ] new: no `to` still addresses the gap's person (the four existing office-verb tests at
      `planner.test.ts:808-880` and `:4456-4458` must pass unchanged)
- [ ] new: an `ask_agent` with `to` on a gap whose `technician_id` is NULL is now ACCEPTED

### Live verification (agent-executable)
- Prerequisites: local Supabase stack, `npm run seed:local`
- [ ] Seed a firm with a technician gap and a separate manager; drive one tick; read back the
      `office_messages` row and confirm `technician_id` is the MANAGER's roster id while
      `nudge_id` is the technician's gap — the cross-channel check the send cannot fake

### Manual verification
- (none — all mechanical)

---

## Phase 3: A message need not be about a gap

### What this phase does
Removes the gap requirement from the decision shape and the decision log, replacing it with an
explicit per-verb rail.

### Changes required

**`supabase/migrations/20260903120000_decisions_without_a_gap.sql`** (new)
- Drop/re-add `nudge_decisions_subject_check` (`20260901130000:125-129`) so BOTH ids may be null.
  Header states what a both-null row MEANS: a message about nobody's gap.
- `alter table nudge_decisions add column if not exists to_ref text` and `via text`.
- `create or replace view mv_whiplash` with `where coalesce(d.nudge_id, d.observation_id) is not
  null` added to the partition source. NOTE: `mv_*` are PLAIN VIEWS (`create view`,
  `20260823230000` / `20260824020000`) despite the prefix — there is no refresh.
- DEPLOY ORDER header: apply BEFORE the code.

**`src/db/nudgeDecisions.ts`** — `NudgeDecisionInput.nudgeId` → `nudgeId?: string | null`; add
`toRef`, `via`; `recordNudgeDecisions` (`:81`) writes both ids null when absent. `safeJobId` must
tolerate a null nudgeId in its log line. Fix the now-false comment at `:182-183`
("unreachable: nudge_decisions_subject_check").

**`src/teamLead/plannerPrompt.ts`** — remove `nudgeId` from `required`; description gains
"Required for hold, close, dismiss and recover. For send, include it only when the message is
ABOUT a gap."

**`src/teamLead/planner.ts`**
- `PlannerDecision.nudgeId` / `DroppedDecision.nudgeId` → `string | null`.
- `validateDecisions`: `hold|close|dismiss|recover` without a `nudgeId` refused ("<verb> needs the
  gap it acts on"); `seen` and `views.get` apply only when present; a gap-less non-send refused.
- **The recorder must admit a gap-less row**: the gate at `:3201` (`if (!views.has(d.nudgeId))
  continue`) and the `stageById.get(nudgeId)` construction at `:3110` both assume a gap. A
  gap-less decision takes a distinct branch writing `nudgeId: null`, `jobId: null`, `toRef`,
  `via` — including for a REFUSED one, which is the most informative row in the log.

**`src/db/observations.test.ts:167-173`** — this test pins the both-null insert as `23514`. It is
asserting exactly the constraint this phase removes; rewrite it to assert the new rule (both ids
null is now legal; the row is a message, not a gap decision).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] migration applies to the local stack and is re-runnable (run it twice)
- [ ] new: each of the four gap verbs is refused without a `nudgeId`
- [ ] new: `recordNudgeDecisions` writes a both-null row; `listDecisionsForNudges` returns it for
      no gap
- [ ] new: a REFUSED gap-less send is still recorded

### Live verification (agent-executable)
- Prerequisites: local Supabase stack
- [ ] Insert a both-null decision through the real writer **carrying a job_id**, then
      `select * from mv_whiplash` and `select * from mv_gap_outcomes` (plain SELECT — these are
      views) and confirm neither gains a row and neither errors. The job_id is what makes this
      test the partition fix rather than a pass on the pre-existing `r.job_id is not null` filter.

### Manual verification
- (none — all mechanical)

---

## Phase 4: One verb

### What this phase does
Collapses `send`/`ask_agent`/`inform_agent` into one `send` with `as`, and opens the verbatim-chat
leg for messages that are not the question of record. Spine-side only.

### Changes required

**`supabase/migrations/20260903130000_office_messages_via.sql`** (new)
- `add column if not exists via text not null default 'assistant'` + CHECK
  `via in ('assistant','chat')`. `'assistant'` is the default because every existing row is one.
- `add column if not exists message_group_id uuid` — nullable, no FK, unused this build (the
  build-8 concession above). Header says so plainly.

**`src/teamLead/planner.ts`**
- `PLANNER_ACTIONS` (`:127`) → `['send','hold','close','dismiss','recover']`, tombstoned in the
  house style.
- `PlannerDecision`: `questionDraft` → `message` (17 references across `planner.ts`,
  `nudgeDecisions.ts`, `planner.test.ts`, `server.test.ts`, `lifecycle.test.ts` — mechanical and
  typecheck-enforced); add `as: 'chat' | 'assistant'`, `countsAsTheAsk?: boolean`; drop
  `agentMessage`. The DB column stays `question_draft` (the `handoff_note` precedent).
- `validateDecisions`: one `send` branch. Rails in order — `as` required; `to` optional, defaulting
  to the gap's person, and resolvable when given; the addressee must support `as` (honest refusal
  naming what is missing); `message` required and date-railed via `cleanPlannerText`;
  **the ambiguity rail** — with `gapNames(view, addresseeId)` as a named predicate comparing FKs
  (`view.nudge.technician_id`, never refs — `ctxStr` can be absent, which is why apply falls back
  at `:2384`): if `as === 'chat'` && `nudgeId` names a gap && `gapNames(...)`, then
  `'countsAsTheAsk' in d` must hold. `countsAsTheAsk: true` is refused unless all three hold AND
  the gap is not already `asked` ("that question is already with them; send it again as a
  message"). Group rails and the send stage rail sit behind `countsAsTheAsk`.
- `applyDecision`: the `send` case forks. `countsAsTheAsk` → today's nudges path unchanged.
  Otherwise `createOffice({ tenantId, direction: 'to_agent', kind: 'inform', fromRef:
  TEAM_LEAD_REF, toRef: <resolved ref>, technicianId: <resolved id>, nudgeId: d.nudgeId ?? null,
  body: d.message, status: 'queued', via: d.as })` — `direction` MUST be `'to_agent'` (both the
  addressee CHECK and `listQueuedOfficeMessagesForHost:157` require it). Delete the
  `ask_agent`/`inform_agent` case.

**`src/jobs/watchers.ts`** — `PLANNER_JUDGMENT_ACTIONS` (`:142-154`) drops the two office verbs;
`attentionActions` (`:812-817`) GAINS them, so historic rows still count as attention (build 6's
pattern for `escalate`/`leave`).

**`src/control/nudgeQueue.ts`**
- `DeliveryReportResult` (`:194`) gains `'delivered'` — the office settle has no `asked` state.
  `handleNudgeReport` (`httpServer.ts:334`) passes it through.
- `buildNudgeDelivery` (`:78`) appends this host's queued `via='chat'` office rows, using the
  office counters (`setOfficeMessageServeCount` / `setOfficeMessageAttempts`) and the same freeze
  doctrine. `sessionId: \`chat-${row.id}\``, `replyTo: tech.telegram_user_id`, `directMessageB64`
  from `body`. Skip a row whose technician has no `telegram_user_id` — frozen, not failed.
- `completeNudgeDelivery` (`:200`) — **restructure the `if (!row)` branch**. Today it returns
  `'ignored'` for any non-delivered report at `:224` and falls into the group path at `:225-234`,
  so an office id can never reach a fallback. Try `getQueuedOfficeMessageForHost` FIRST inside
  `if (!row)`; a chat row settles via `setOfficeMessageDelivery` on `delivered` and bumps
  `setOfficeMessageAttempts` on `failed` (without this, a chat row can never reach
  `MAX_DELIVERY_ATTEMPTS` and freezes only at `MAX_SERVE_COUNT`). The existing closed-lead group
  path runs only when neither table claims the id.

**`src/control/officeQueue.ts`** — `buildOfficeDelivery` filters `via = 'assistant'`, or a chat row
is injected as an agent turn as well as texted.

**`src/db/officeMessages.ts`** — `CreateOfficeMessageInput` gains `via` (and `messageGroupId`);
`listQueuedOfficeMessagesForHost` gains a `via` filter.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] both migrations applied; re-runnable
- [ ] the pins, each named: `planner.test.ts:3021-3031` (enum == actions),
      `watchers.test.ts:1227` (judgment set) and **`:1234` (`toHaveLength(7)` → 5)**
- [ ] new: a chat send with `countsAsTheAsk` queues a NUDGE and no office row; without it, an
      office row with `via='chat'` and no nudge movement
- [ ] new: the ambiguity rail refuses when the flag is ABSENT, and accepts `false`
- [ ] new: `countsAsTheAsk` on an already-`asked` gap is refused
- [ ] new: `buildNudgeDelivery` returns a nudge item and a `via='chat'` item for one host;
      `completeNudgeDelivery` settles each on the correct table, and a `failed` report bumps the
      office row's `attempts`
- [ ] new: `buildOfficeDelivery` never returns a `via='chat'` row

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; the HTTP server startable locally with a seeded host token
- [ ] Drive a real pull against `/control/nudges`, confirm the response carries BOTH kinds of item,
      POST `delivered` for each id, and read both tables back: the nudge is `asked`, the office
      row is `delivered`. Capture the raw JSON both ways.
- [ ] POST `failed` for a chat id three times and confirm the row freezes on attempts, not serves

### Manual verification
- [ ] Read the rendered `SUBMIT_PLAN_TOOL` and `PLANNER_SYSTEM` end to end (per
      `read-the-rendered-artifact`) and confirm nothing instructs the model toward a deleted verb

---

## Phase 5: Seeing what you sent

### What this phase does
Closes the loop: the planner sees its own outbound traffic and the age of its unanswered asks, and
is told in one document how five verbs and two legs work.

### Changes required

**`src/teamLead/planner.ts`**
- `buildOutboundBlock(rows: OfficeMessage[], nowMs): string` — recent `to_agent` rows, newest
  first, capped and honestly truncated: `WHAT YOU SENT` / `  [id] to <to_ref>, <age> ago, <via>:
  <body>`, marking an assistant message that has a reply. **It must NOT claim "no reply" for a
  chat row**: `in_reply_to` is written only by `inform_team_lead` (`server.ts:2985-2995`), and a
  person answering a CHAT message answers their assistant, which files a `record_field_note` and
  no office row — so a reply-keyed definition would leave every chat message in the list forever.
  The block reports what was sent and when; judging silence is the planner's, from the evidence.
- `buildGapView` already prints `asked: <n>h ago` on an asked row. What it does NOT say is whether
  anything came back, or that the planner has asked more than once — so extend that line to
  `asked: <n>h ago, no answer yet` (or `answered`) and append `· asked <k>x` when `serve_count > 1`
  plus the count of chat messages sent about this gap since. This is what makes asking again a
  judgment rather than a guess.

**`src/teamLead/plannerPrompt.ts`** — the doctrine as ONE document: five verbs; THE TEAM
and how to copy a ref; the two legs and what each costs (a chat message arrives in their own
assistant's voice and pings them; an assistant message lands silently and may not be passed on);
what makes a message the question of record; when to ask again, and that asking again is a message
rather than a state change. **And what to do when a gap's person has left the firm:** that
question will never be answered by them, so ask somebody else about it or end it — the one case
where the gap in front of the planner is stale rather than merely unresolved. Delete every line
naming `ask_agent`/`inform_agent` — including the
one pinned by **`planner.test.ts:4871`** (`toContain('reach the person through \`ask_agent\`')`),
which must be rewritten to pin the replacement sentence.

**`src/eval/plannerCorpus.ts`** — a `BUILD65` family: address a manager about a technician's gap; a
gap-less send; the ambiguity rail; asking again after silence. Count the newly-orphaned
`ask_agent`/`inform_agent` expectations and record the number in the header, as build 6 did.
Every scenario must fail if the planner does nothing (build 6's lesson).

**`src/eval/plannerSim.ts`** — a step kind for an outbound office row aging without a reply, so the
ask-again scenarios have something to see.

**`docs/engineering-memory.md`** — §6a entry 6.5 marked BUILT: what was accepted, and what was
deliberately left (the board leg, several addressees, the quiet-firm skip, no `v_office_messages`).
Amend the `re-ask-belongs-to-6-5` memory with the corrected mechanics.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] `npm run decisions:index` regenerated and committed
- [ ] new: `buildOutboundBlock` renders nothing with no outbound traffic, truncates honestly, and
      does NOT mark a chat row as unanswered
- [ ] new: the ASKED line renders age on an asked gap and nothing on a never-asked one
- [ ] new: the rendered doctrine names no deleted verb (a grep-style assertion)
- [ ] new: every `BUILD65` scenario fails when the planner does nothing

### Live verification (agent-executable)
- Prerequisites: local Supabase stack; a real model key for one shadow tick (`.env`), else skip
      with the reason recorded
- [ ] Drive one real tick against a seeded firm with an unanswered outbound message and confirm
      the rendered user message carries the outbound block with the right id — read it from the
      tick's own recorded prompt, never a reconstruction

### Manual verification
- [ ] Read the rendered doctrine as if you were the planner: is it obvious who you can reach,
      which leg to use, when a message becomes the question of record, and that asking again is
      allowed?
