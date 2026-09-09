---
date: 2026-09-08
task: give the manager seat a door that can cite the caller's own email, and close the two tool defects the live test exposed
research: thoughts/shared/research/2026-09-09-who-may-write-l2.md
status: draft
supersedes: nothing
---

`supersedes: nothing`. This does not overturn a decision — it completes rung 10b. The
2026-09-07 ruling ("the planner writes L2") stands; this adds a second writer that must meet
the *same* evidence bar, and says so in the mechanism rather than in prose.

## Overview

Rung 10b built `record_caller`: a door where every write cites the L1 capture it came from, so
answering "who was that caller?" leaves proof rather than a claim. The live test on 2026-09-08
showed the door works and that **nothing reaches it**. The manager's answer arrives at the
*seat*, and the seat is refused `record_caller` by the team-lead ceiling
(`src/mcp/server.ts:2736`). So the seat answered with the tools it had, and produced: a re-typed
copy of the customer's email in L1, a customer whose `address_line1` is her own name, a
`completed` visit that never happened, and an item that is still open because nothing cites the
original email.

This plan gives the seat the citing door, fixes the attribution that door hardcodes to the
planner, and closes the two tool defects that produced wrong rows independently of any of that.

Evidence for every claim below is in the pilot: observation `a25b4906-556e-4e10-88d7-e39a5cc5f78f`
(still open), capture `3d18b1cd-1e0c-438d-a2c5-a0d2b82d7b17` (cited by nothing), customer
`291921e1-98e0-420b-9d38-a89077af502b`, visits `e83a233a…` (completed, untimed) and `134a0332…`.

## Decisions

- **Who may answer an unmatched-caller item — the seat, or only the planner?** Options were
  (a) doctrine only: tell the seat to relay and never write; (b) refuse the collision: block the
  seat's *mint* while a matching item is open; (c) give the seat the citing door. **Chosen: (c)**,
  by the user across the 2026-09-08 session. Reasoning that decided it: the seat writing is not
  the defect — a manager recording through their own assistant is the product. The defect is that
  the seat's write could not *cite* anything, so the item could not see it. (a) is the same
  advisory text the assistant already stepped over once. (b) treats a permitted action as a
  violation. Decisive practical point: `inform_team_lead` is a bucket write that no model call
  reads until the next tick (`src/mcp/server.ts:3080-3084`), and the planner cannot place a visit
  on a day at all (no `move_visit`/`book_visit` in `TEAM_LEAD_TOOL_NAMES`) — so the planner road
  makes the manager wait up to 30 minutes for a customer to exist and still cannot honour
  "Thursday morning". The seat road does the whole thing in one conversation.
- **Does the item still close off the record, rather than off a message?** **Yes, unchanged.**
  `mootFactFor` (`src/teamLead/planner.ts:4320-4344`) asks only "does anything cite this capture",
  never who wrote it — so a seat write closes the item exactly as a planner write does, with no
  planner change at all. Keeping closure record-derived is what made today's failure *visible*:
  had "I have handled it" been enough, the item would have closed over a record citing nothing.
- **`book_visit` untimed becomes explicit.** Today `const untimed = !date && !startTime &&
  !endTime` (`src/mcp/server.ts:4844`) — omitting the date IS the untimed signal, so a stated day
  can be dropped silently, which is exactly what happened ("Book it unassigned" → booked untimed
  while the reply itself named Thursday 2026-09-10). Requiring `untimed: true` makes an omission
  an error instead of a decision.
- **The address guard is narrow.** `confirmed.address` both unlocks the customer mint and becomes
  `address_line1` unchecked (`src/mcp/server.ts:2146-2155`). Rather than restructure the mint,
  refuse the one shape that fabricates: an address equal to the customer's own name. Cheap, and
  it targets the observed failure without changing what a legitimate confirm can do.
- **`record_caller` attributes its writes to the caller, not to the planner.** The door hardcodes
  `actorRef: TEAM_LEAD_REF` when booking (`src/writePath/recordFieldNote.ts:664`). With a second
  caller that becomes a lie on the schedule event.
- **`newCustomer.email` may not be the firm's own mailbox.** The live run's sender WAS the watched
  mailbox (the user mailed the pilot from itself) and the extractor recorded it as the customer's
  email. Filed onto a customer, every future self-sent mail would match them by the email key.
  `record_caller` refuses a `newCustomer.email` equal to the capture's `to` address (case-folded);
  the inbound door stops offering the sender as `fallbackEmail` when it equals `to`. Narrow and
  cheap; it also protects Phase 3's Test B, which needs the customer row to carry NO email.
- **RESOLVED (was OPEN) — the phantom `completed` visit from a manager's relayed note is NOT fixed
  here, and not by a channel.** It is one of the SIX L2 writes `recordFieldNote` performs from a
  technician note, and the user's 2026-09-09 doctrine moves all of them (five to the planner,
  `labor_hours` deleted) as rung 10d — see `docs/engineering-memory.md` §10b-live. A
  `manager_assistant` channel would be dead code the day 10d lands. This plan stays narrow: the
  seat gets the citing door, so the relay case has a correct path, and 10d closes the class.

## Plain-language walkthrough

**Phase 1 — the seat gets a door that can point at the email.** Right now there are two roads
into the record and the item only watches one of them:

```
  item: "who is this caller?"  ── closes when ──►  something cites the caller's email
                 │
   ┌─────────────┴─────────────┐
PLANNER road                 SEAT road
record_caller                record_field_note / book_visit
cites the email     ✓        cites a re-typed copy   ✗
refused to the seat ✗        what the seat actually has
```

After this phase the seat can take the same road the planner takes. The manager says "set her
up and open a job", and the customer, the job and the trip all point back at her actual email —
so the item retires on its own, and a later reply on that same email thread can find her.
You would notice it working by there being no second copy of her email in the log, and by the
item going quiet without anyone closing it by hand.

**Phase 2 — two tools stop accepting an omission as an answer.** `book_visit` currently reads
"no date given" as "book it with no date", so a day the manager stated can vanish. After this it
has to be told `untimed: true` out loud. And the note door currently lets a customer be created
by asserting an address, without checking the address is one — that is how a person's name ended
up as her street. After this it refuses that one shape.

**Phase 3 — clean the pilot and re-run both live tests, chained.** Delete the four wrong rows,
retire the stale item, then: a stranger emails → the item is raised → the manager answers → the
record cites her email. Then reply on that same thread. Because she will be on file with **no
phone and no email stored**, the conversation key is the only route left, so a match proves it
outright — the isolation the water-heater thread could never give us.

## Secrets & env preflight

- **Phase 1:** none — `record_caller` and the door are already deployed.
- **Phase 2:** none.
- **Phase 3:** none for the code; the live run needs the deployed pilot and a sending address that
  is not on any customer row.

### ⚠ Phase 3 has a DEPLOY STEP the code cannot supply

The manager `tools/list` moves 42 → 43. Gateways cache `tools/list` per process, and rule 7's
wording is baked into each sandbox's AGENTS.md at `wire` time. So after the Render deploy, and
BEFORE Test A, every manager sandbox needs:

```
nemoclaw <seat> gateway restart     # or it serves its cached 42-tool list — no record_caller
# and a box `wire` re-run so AGENTS.md rule 7 names the tool
```

Skip these and the seat cannot see the door, answers through `record_field_note` again, and the
2026-09-08 specimen reproduces exactly — reading as a code failure when it is a missing restart.
(`docs/nemoclaw-tech-agent.md` carries the same warning; that file's older "the manager side needs
no restart" line is about the 2026-07-31 change only.)

---

## Phase 1: the citing door on the manager seat

### What this phase does
Lets an active manager badge dispatch `record_caller`, and makes the writes it performs name the
badge that asked for them instead of the planner.

### Changes required

**`src/mcp/server.ts`**
- Split the team-lead-only set so the ceiling still fails closed but `record_caller` is shared.
  Replace the derived `TEAM_LEAD_ONLY_TOOL_NAMES` (line 1989) with the derived set MINUS the
  shared names, keeping it derived so a new team-lead tool is still gated the day it is added:
  ```ts
  // Shared with the manager seat (2026-09-08): the manager's own assistant is
  // where a caller's identity is actually settled, and this is the only door
  // whose every write cites the capture. Kept as an explicit exception list so
  // the ceiling stays deny-by-default for everything else.
  const SEAT_SHARED_TEAM_LEAD_TOOLS = new Set(['record_caller']);
  const TEAM_LEAD_ONLY_TOOL_NAMES = new Set(
    TEAM_LEAD_TOOLS.map((t) => t.name).filter((n) => !SEAT_SHARED_TEAM_LEAD_TOOLS.has(n)),
  );
  ```
- At the dispatch gate (line 2736 area) add the tier check for the shared names — an ACTIVE
  MANAGER only, never a technician, never an inactive badge. Reuse the existing
  `activeManager` computation (line 2686):
  ```ts
  if (SEAT_SHARED_TEAM_LEAD_TOOLS.has(name) && !identity.technicianRef.startsWith('spine:')
      && !activeManager) {
    throw new Error('recording who a caller was is a manager\'s call — tool not allowed');
  }
  ```
- Serve it: `MANAGER_TOOLS` (line 1998) gains the `record_caller` schema from `TEAM_LEAD_TOOLS`
  so the seat can discover it. Take the schema object rather than re-declaring it — one schema,
  two catalogs.
- Reword the two sentences in the `record_caller` description that assume a planner reader:
  "The item CLOSES ITSELF on the record at your next pass" becomes wording that is true for both
  callers (the item retires on its own once the record cites the call — never close it by hand),
  and the `bookVisit` line keeps its untimed meaning but points at `move_visit` for placing a
  stated day, since a seat CAN place one.
- Pass the acting ref into the door (see below).
- **Own-mailbox guard.** In the `record_caller` dispatch, after `newCustomer` is validated: read
  the capture's `metadata.to`, and if `emailAddressOf(newCustomer.email)` equals
  `emailAddressOf(to)` refuse with a message saying that address is the firm's own mailbox, not
  the caller's. Test: a capture whose `from` equals its `to`, answered with that email → refused;
  answered with the name only → created with `email IS NULL`.

**`src/inbound/webhook.ts`**
- `fallbackEmail` becomes null when `emailAddressOf(meta.from) === emailAddressOf(meta.to)` (both
  present), so a self-sent message never offers the firm's own address as the caller's identity.
  One test: from == to → the door's `fallbackEmail` is null; from ≠ to → unchanged.

**`src/writePath/recordFieldNote.ts`**
- `RecordFieldNoteInput.decided` gains an optional `actorRef?: string`. Line 664's
  `actorRef: TEAM_LEAD_REF` becomes `input.decided?.actorRef ?? TEAM_LEAD_REF` so the schedule
  event names whoever actually booked. Default preserved, so the planner path is unchanged.

**`src/mcp/server.test.ts`** (or the existing `record_caller` describe)
- a manager badge dispatches `record_caller` and the writes cite the capture;
- a **technician** badge is refused;
- an inactive/offboarded manager is refused;
- a `spine:` identity still dispatches it (no regression);
- a `spine:` identity is still refused every other team-lead-only name (the ceiling holds);
- the booked visit's schedule event names the manager, not `spine:team-lead`.

### Automated verification
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test` — 2842 passed; the one failure
      (`plannerPass > missing credentials block`) reproduces on stashed main, env-dependent
- [x] new tests above pass (26 in the `record_caller` describe, 11 in `format`, 4 in `webhook`)

### Live verification (agent-executable)
Deferred to Phase 3 — the live run is the same e2e, and running it twice costs a real billed
inbound each time.

### Manual verification
None.

---

## Phase 2: an omission stops counting as an answer

### What this phase does
Makes `book_visit` require an explicit untimed flag, and refuses the confirm shape that
fabricated an address.

### Changes required

**`src/mcp/server.ts`**
- `book_visit` inputSchema: add `untimed: { type: 'boolean' }`, described as the only way to book
  with no day — and state that a day the manager stated must be passed as `date` + times, or
  asked about, never dropped.
- Dispatch (line 4844): `const untimed = args.untimed === true;` then
  - all three of date/startTime/endTime absent AND `!untimed` → refuse, naming the fix
    ("pass the day and both times, or `untimed: true` if the manager said the timing is not
    settled — never drop a day you were given");
  - `untimed` true together with any of the three → refuse (contradiction, fail loudly).
- Description: replace "omit all three to book untimed" with the explicit flag.
- `record_field_note` confirm path: before `resolutionFrom` mints, refuse when
  `confirmed.address` case-folds equal to the customer name it is about to use
  (`match.createFrom?.customerName ?? extracted.customerName`), with a message saying an address
  is where they are, not who they are.

**tests**
- `book_visit`: bare call with nothing → refused; `untimed: true` → books untimed; `untimed`
  with a date → refused; date + both times → unchanged;
- `record_field_note`: `confirmed: { address: 'Ruth Bramley' }` against extracted name
  "Ruth Bramley" → refused; a real address still mints.

### Automated verification
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test` — 2845 passed; the one failure (`plannerPass > missing credentials block`)
      reproduces on stashed main, env-dependent
- [x] new tests above pass (4 `book_visit` shapes; the address guard on BOTH doors, with the
      evasion set and the escape-hatch wording)
- [x] `npm run build`

### Manual verification
None.

---

## Phase 3: clean the pilot, then re-run both tests chained

### What this phase does
Removes the wrong rows, retires the stale item, and re-runs the two live scenarios as one chain.

### Steps
1. **Cleanup (pilot writes, per-path, never a truncate).** Delete visits `e83a233a…` and
   `134a0332…` and their participants, job `212ccc4d…`, customer `291921e1…`. The re-typed L1
   capture `79776a0e…` STAYS — L1 is append-only. Retire observation `a25b4906…` as dismissed
   with a reason naming this cleanup, so it stops being re-asked.
2. **Test A — the new caller.** A stranger emails the pilot mailbox from an address on no
   customer row. Expect within ~15s: `inbound_unmatched` open, `pinged_at` set, zero review
   items, one chat message + one assistant note. Manager answers with **the name only** — no
   email address, so nothing stores one.
   Read back: customer/job/visit all `source_capture_id` = the email's capture; item retires on
   the next tick without anyone closing it.
3. **Test B — the conversation key, isolated.** Reply on that same thread. With no phone in the
   text and no email on the customer row, phone/email/address keys all miss and the thread key is
   the only route. Expect the reply filed against the customer created in Test A.

### Automated verification
- [x] cleanup read-back (2026-09-09) — **and the plan was wrong about what could be deleted.**
      `schedule_events` is append-only, and its FK to `visits` is `ON DELETE SET NULL`, so the
      trigger refuses the FK's own update: a visit carrying schedule events can never be hard
      deleted, and `customers → jobs → visits` are all CASCADE, so the whole cluster is pinned by
      two event rows. Actual result:
      - visit `e83a233a` (the phantom `completed` trip) — **DELETED** (it had no schedule events)
      - visit `134a0332` — **cancelled** (undeletable; cancelled visits are dropped by
        `listL2CitingCapture` and come off the board)
      - job `212ccc4d` — **cancelled** (same reason)
      - customer `291921e1` — **PERMANENT.** `address_line1 = 'Ruth Bramley'` stays on the pilot
        forever. Inert for the re-run (`phone` and `email` both NULL, so no identity key can
        match it) but it is a real bad row, and a second demonstration of the thing this rung is
        about: nothing in this system is easy to take back.
      - L1 captures `79776a0e` and `3d18b1cd` — both still on file, as append-only requires
      - observation `a25b4906` — **dismissed** with a reason; **0 open inbound items** remain

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (read-back), the deployed pilot, **the gateway restart + box
  `wire` above — verify `record_caller` is in the seat's tools/list before sending anything**, and
  the user sending two emails
- [ ] Test A: item raised, cited writes, item retires on its own — evidence: observation row +
      `source_capture_id` on all three L2 rows
- [ ] Test B: the reply lands on Test A's customer — evidence: the citing row, plus the customer
      row showing `phone IS NULL AND email IS NULL` so no other key could have matched

### Manual verification
- [ ] the text on the manager's phone reads like a person asking a real question

---
*Pause after Phase 3's manual item.*
