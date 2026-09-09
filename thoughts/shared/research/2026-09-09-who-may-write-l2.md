---
date: 2026-09-09
branch: main
commit: dd4ac1f
topic: the L2 write surface — every door that brings a customer, job or visit into existence, who can reach each one, and what makes an item close
supersedes: nothing
---

`supersedes: nothing`. This documents the code as it stands at `dd4ac1f`; it overturns no earlier
document. It is the missing research behind
`thoughts/shared/plans/2026-09-08-the-citing-door-on-the-seat.md` (rung 10b.2), whose frontmatter
reads `research: none`, and it is the map rung 10d will need.

## Summary

The spine has three layers: **L1** (`raw_captures`) is the append-only log of what people actually
said, **L2** is the structured record the firm operates from (`customers → jobs → visits`), and
**L3** is a JSONB `attributes` column on each L2 row. This document answers one question about
that middle layer: *when a customer, a job or a visit comes into existence, which code did it, who
was allowed to ask, and how does the system know afterwards that a question was answered?*

The short version. There are **exactly three code paths** that create L2 objects, and **exactly
six creation/lifecycle writes** reachable from a technician's field note. Fifty tools are served
across three catalogs, and only six of them can create anything — five are manager-only or
planner-only, and **one, `record_field_note`, sits in the catalog every technician holds**. An
"item" (an `observations` row) is closed not by anyone declaring it answered but by a purely
record-derived test: *does any L2 row cite the capture this item is about?* That test is
author-blind, which is why a live run on 2026-09-08 could produce four wrong rows and still,
correctly, leave the item open.

## Entry Points

| where a request arrives | file | what it can create |
|---|---|---|
| MCP tool dispatch (seats: technician + manager badges) | `src/mcp/server.ts:2686`–`2760` (gates), then the `case` blocks | via `record_field_note`, `open_job`, `book_visit`, `add_technician_seat` |
| MCP tool dispatch (`spine:` planner identity) | same dispatch, capped at `src/mcp/server.ts:2725` | via `record_caller` only |
| Composio inbound webhook (email/call) | `src/inbound/webhook.ts` → `recordFieldNote` | jobs/visits only with a relayed manager decision |
| the planner's tick | `src/jobs/lifecycle.ts` (cadence + fallback) and `src/calls/observationPing.ts:63` (the ping loop) | nothing directly; it dispatches tools |

## Key Files

**`src/writePath/recordFieldNote.ts`** — *the door.* Every capture, from any channel, is appended
to L1 and resolved here. Exports `recordFieldNote`. Its `RecordFieldNoteInput.decided`
(line 98–101) carries a manager's relayed answer (`openJob`, `bookVisit`); `captureId` makes the
call a **re-entry** on an existing capture rather than a new append — that pair is the mechanism
`record_caller` uses.

**`src/writePath/attachNote.ts`** — *which trip does this note belong to?* Exports
`resolveVisitForNote`. Three rules in order: a visit placed on the note's own firm-local day with
this technician or nobody on it; else the job's one live visit; else **create one**
(`if (!input.mayCreate) return …` at line 115; `createVisit` at line 116). Attach is channel-blind;
create is not.

**`src/writePath/identityMatch.ts`** — `matchIdentity`, the deterministic matcher. Keys in order
phone → email → thread → address, each unique-or-refuse, then the technician's schedule for the
capture's firm-local day. Accumulates a `tried: string[]` that becomes the refusal's `reason`.

**`src/mcp/server.ts`** — the tool catalogs and the dispatch gates (details below).

**`src/teamLead/identity.ts:54`** — `TEAM_LEAD_TOOL_NAMES`, the deny-by-default ceiling for the
`spine:` namespace.

**`src/teamLead/planner.ts:4321`** — `mootFactFor`, the record-derived closing test.

**`src/db/observations.ts:256`** — `PINGED_KINDS = ['inbound_new_job','inbound_commitment','inbound_unmatched']`.

**`src/db/rawCaptures.ts:519`** — `listL2CitingCapture` returns five kinds:
`job | visit | customer | link | note`.

**`src/db/visits.ts:605`** — `recordVisitReport`'s hours merge.

## Data Flows

### 1. Every L2 creation in production code

Excluding tests and `src/eval/plannerSim.ts`, these are all of them:

```
THE DOOR (recordFieldNote)                    reached by record_field_note, record_caller, the webhook
  recordFieldNote.ts:392   createCustomer     staged: needs_confirmation, explicit yes required
  recordFieldNote.ts:569   createJob
  attachNote.ts:116        createVisit        untimed + status 'completed' — a RECEIPT, not a plan

bookVisit()                                   reached by book_visit (manager), record_caller.bookVisit
  booking.ts:556           createJob          the customerId path mints a job as well
  booking.ts:577           createVisit

open_job                                      reached by open_job (manager)
  server.ts:4758           createJob
```

Lifecycle writes (changing an existing row) add three more, two of them in the door:

```
  recordFieldNote.ts:709   recordVisitReport        labour hours + attributes onto the trip
  recordFieldNote.ts:742   updateVisitStatus→completed   THE ONLY 'completed' WRITE IN THE CODEBASE
  recordFieldNote.ts:782   updateJobStatus          note-blessed transitions only
  booking.ts:593/998/1296/1312                      cancellations only
```

**`updateVisitStatus(…, 'completed', …)` has exactly one call site.** Nothing else — no manager
tool, no planner tool — can mark a trip as having happened. Any plan that removes the door's
mint must supply that verb in the same change, or an unbooked trip is stranded `confirmed`
forever and chased by the overdue watcher.

### 2. The six writes reachable from a technician's field note

`isTechnicianChannel` (`recordFieldNote.ts:410`) is computed from the capture channel;
`mayCreate: isTechnicianChannel` (line 606) is what unlocks the receipt trip. So one note can
reach: `createCustomer`, `createJob`, `createVisit`, `recordVisitReport`,
`updateVisitStatus→completed`, `updateJobStatus`.

### 3. Who may reach which door

```
TOOLS (17)          technicians AND managers   → record_field_note is the ONLY creator
ADMIN_TOOLS (26)    managers only              → open_job · book_visit · add_technician_seat
                                                 record_money_event · add_time_off
TEAM_LEAD_TOOLS (7) the planner only           → record_caller
```

Two gates, both in the dispatch, both deny-by-default and in opposite directions:

```ts
// server.ts:2725 — the spine: namespace is capped to the allowlist
if (identity.technicianRef.startsWith('spine:') && !TEAM_LEAD_TOOL_NAMES.has(name)) throw …

// server.ts:2736 — and team-lead-only names are refused to everyone else
if (TEAM_LEAD_ONLY_TOOL_NAMES.has(name) && !identity.technicianRef.startsWith('spine:')) throw …
```

`TEAM_LEAD_ONLY_TOOL_NAMES` (line 1989) is *derived* from the array, so a new team-lead tool is
gated the day it is added. `MANAGER_TOOLS` (line 1998) is `TOOLS` minus `get_schedule` plus
`ADMIN_TOOLS` — `record_caller` is in neither, so the manager's seat cannot discover it **or**
dispatch it. That second gate, not mere non-discovery, is what 10b.2 changes.

### 4. What closes an item

`mootFactFor` (`planner.ts:4321`) is the only closing test for the three inbound kinds. It reads
`listL2CitingCapture(captureId)` and asks whether anything cites the capture — for
`inbound_unmatched`, a customer created from it, a job opened from it, a visit booked from it, a
`job_captures` link, or a `visit_notes` attachment. **It never asks who wrote the row.** So a seat
write closes an item exactly as a planner write does, with no planner change required.

```
inbound message
   → L1 append (append-only, undeletable)
   → work/personal classifier gates the INSERT (never after)
   → extract  →  matchIdentity
        matched   → file on the job / attach to the trip
        refused   → observations row, kind inbound_unmatched, context carries
                    { captureId, words (1500 chars), asked:{extracted fields},
                      channel, capturedAt, matchReason, visitCommitted }
   → ping loop claims it (pinged_at) → focused planner pass → asked_at → a manager's phone
   → someone writes something that CITES the capture
   → next tick: mootFactFor sees the citation and retires the item
```

### 5. The two ways the planner wakes

```
observationPing.ts:63   list(PINGED_KINDS, 1) → claim (pinged_at) → focused pass    ~10s
lifecycle.ts            due at :00 and :30, plus a 35-min unclaimed-observation fallback
```

`inform_team_lead` (`server.ts:3079`) is **not** a wake source: its own comment says *"a plain
bucket write — NO model call fires on receipt … the next planner tick reads and organizes it."*
Measured 2026-09-08: a seat message written at 22:21:07Z flipped to `read` at the 22:31 tick.
Making it wake the planner is rung 10c.

### 6. The existing citation bridge for seat tools

`inboundAskFor` (`server.ts:2513`) finds *the one* open pinged observation for a customer or job
that was `asked_at` within `CITE_ASK_WINDOW_MS`, and returns its capture id. `open_job`
(line 4758) and `book_visit` both stamp `sourceCaptureId` from it and copy the caller's words onto
the job. `open_job`'s comment states the division explicitly: *"The observation is NOT touched
here: closing it is the planner's, on the citation this just left behind."*

**`record_field_note` never calls it.** It appends its own capture and cites that. Of the seat's
three creators, two cite and one does not — that asymmetry is the whole of the 2026-09-08 failure.
`inboundAskFor` also cannot serve an `inbound_unmatched` item: it matches on `customerId`/`jobId`
in the observation context, and for an unmatched caller neither exists yet. That is why
`record_caller` takes an explicit `observationId`.

## External Dependencies

- **Composio** — the Gmail trigger (`GMAIL_NEW_GMAIL_MESSAGE`) delivering to
  `src/inbound/webhook.ts`, and `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` for thread context
  (`src/composio/threads.ts`, 8s deadline, billed either way).
- **OpenRouter** — `z-ai/glm-5.3` for the extractor, the classifier, the planner and the seats.
- **Supabase/PostgREST** — every read and write; `max_rows = 1000`, `.in()` URLs 414 past ~8KB.
- **Telegram** — the delivery surface for everything the planner says to a person.

## Constraints and Invariants

1. **L1 is append-only.** No update, no delete, enforced by a DB trigger. Any filtering must gate
   the insert. A capture that pins a customer makes that customer permanently undeletable.
2. **`updateVisitStatus → 'completed'` has one call site** (`recordFieldNote.ts:742`), guarded by
   technician channel + note filed at or after the visit's start. The guard exists because an
   inbound *"nobody ever showed up"* also arrives after the start, and flipping on it would erase
   the trip from `listOverdueConfirmedVisits` — silencing the detector with the very message
   complaining nobody came.
3. **`recordVisitReport` ACCUMULATES hours**: `Number(current.labor_hours ?? 0) + addedHours`
   (`visits.ts:605`). No check against the scheduled window, no cap, no way to correct downward.
   Two notes each saying "two hours" produce four. `jobs.ts:519` calls it out as never-L3, and the
   door's comment calls it cost. Nothing downstream reads it today except the synthesis grounding
   line — a build-order accident, not a design.
4. **`record_field_note` accepts technician channels only** (`TECH_CHANNELS`, `server.ts:266`;
   default `technician_note`). The enum `capture_channel` has carried `manager_assistant` since
   the first migration (`20260620005307_context_spine.sql:19`) and **no code writes it**.
5. **`confirmed.address` both unlocks the customer mint and becomes `address_line1` unchecked**
   (`resolutionFrom`, `server.ts:2138`–`2160`).
6. **Omitting date/startTime/endTime IS the untimed encoding** for `book_visit`
   (`const untimed = !date && !startTime && !endTime`, `server.ts:4844`). An omission and a
   deliberate choice are indistinguishable at the schema level.
7. **Tool prose totals 7,169 words across 50 tools** (`book_visit` alone is 451, `resolve_date`
   489). Live evidence 2026-09-08: the model followed four specific buried `book_visit`
   instructions and violated the description exactly where the schema contradicted it. Prose loses
   to shape.
8. **Deploys run no migrations**, and the pilot's ledger already disagrees with filenames. A
   column drop must land as: code stops reading/writing → deploy → migration.
9. **Ask-first is doctrine, not mechanism** (user, 2026-09-07). The gates above are the only
   mechanical rails.

## Decision Points

- **Where `record_caller` lives.** Sharing it with active manager badges means editing
  `TEAM_LEAD_ONLY_TOOL_NAMES` and `MANAGER_TOOLS` and adding a tier check at the `server.ts:2736`
  gate; the alternative is leaving it planner-only and routing every answer through
  `inform_team_lead`, which no model call reads until the next tick, and through a planner that
  holds no `book_visit`/`move_visit` and so cannot honour a stated day.
- **Whether the door keeps its six writes.** Removing them requires supplying the planner with
  five verbs — including the only `completed` write in the codebase — in the same change. Keeping
  them leaves a technician's seat writing directly into the record a manager operates from.
- **What `labor_hours` is for.** The scheduled window (`starts_at`/`ends_at`, corrected by
  `move_visit`) already records how long a trip was booked for. Keeping the column means keeping
  a second, accumulating, uncompared number; dropping it means the schedule is the only hours
  record.
- **Whether a fourth pinged kind exists.** `PINGED_KINDS` covers new job, commitment, unmatched. A
  known customer asking a question about an existing job matches none, so it is filed silently and
  nothing wakes the planner about it.
- **Whether an omission may encode a decision** — `book_visit`'s untimed path, and by extension
  any other tool where a missing field means something.

## Open Questions

- **How often would a technician's note land somewhere that now needs a decision?** Only notes
  that would create or change L2 need judgment; a note on a job with a live trip attaches
  deterministically. The shape must be derived from the *rule* against a representative corpus,
  never counted off pilot rows.
- **Can the planner's evidence discipline replace the happened-flip guard?** The rule cannot tell
  "done" from "nobody came"; a model can, but nothing pins that today.
- **Why does an identical seat message get written to planner memory only sometimes?** Two runs,
  2026-09-07 23:47Z (lost) and 2026-09-08 22:21Z (kept), with a byte-identical prompt section
  between them. Needs an N-run eval, not another live look.
- **Is the `manager_assistant` channel worth wiring, or dead on arrival?** If the door stops
  minting trips, the channel that would have prevented a phantom trip has nothing left to prevent.
- **Does the Composio thread fetch work at all?** It has never fired in the pilot — the trigger
  attributes to `manager-sam`, and the only roster row carrying
  `composio_connected_account_id` is `tech-jane` (offboarded). Unproven live.
