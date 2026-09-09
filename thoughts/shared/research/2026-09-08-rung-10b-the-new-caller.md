---
date: 2026-09-08
branch: main
commit: 16265e1
topic: Rung 10b — the new caller (and the mis-recognised known one). What happens today when a call or an email matches no customer, on both doors; the identity keys the matcher has and lacks; the planner's write surface as it stands after 10d's ruling; the machinery rung 10 left kind-blind; and every fork the plan has to choose at.
supersedes: nothing
---

**`supersedes:` is not optional bookkeeping.** This document overturns no prior decision. It
records the code as it stands after rung 10 (deployed 2026-09-07) and PR #213 (thread id
captured, 2026-09-08), under the rulings already made: 10b and 10d are ONE PLAN (user,
2026-09-08); the planner gets complete L2 write access with ask-first as doctrine (user,
2026-09-07); the ladder rows are at `docs/engineering-memory.md` §6a. The rung 10 plan's Decisions
recorded 10b as "the manager's agent runs `add_customer`" (commit `5f78aed`); the 10d ruling
replaces that actor, and this document describes the ground for that replacement.

## Summary

Inbound mail and calls reach the spine through one function, `recordFieldNote`, which lands the
words in L1, runs the extractor, and asks `matchIdentity` who this is. When the matcher finds
nobody, the door stops at line 253 and hands back `needs_disambiguation`: no customer, no job, no
observation. What happens next depends on the door. A **call** classified `new_job` opens an
`unlinked_call` review item and pushes "Call — new customer to link" to every manager, and no tool
in the manager's kit can act on it: `resolve_review` only marks it resolved or dismissed, and
nothing re-runs the door for that capture. An **email** gets nothing at all; the webhook flags a
review only when the *mailbox* is unknown, never when the *sender* is. The pilot firm has six open
`unlinked_call` items and six calls parked that way. Worse, the matcher only knows two keys, phone
and street address, both exact-string, so a **known** customer is parked as a stranger whenever
their message carries neither: the first real reply on the pilot mailbox (2026-09-08, Tom Becker
asking to move his booked Friday visit) was parked with zero links, although it was the same sender
and the same Gmail thread as the email that booked him. Rung 10 built the loop that rung 10b needs
— an observation of a pinged kind wakes the planner within seconds, and every helper is kind-blind
by name — and the door already has a `resolved` mode that creates a customer from a chosen identity
and stamps the capture on it. What is missing is one observation kind, two identity keys (email and
thread), a way back into the door for a capture that already exists, and, under the 10d ruling, a
first write tool on the planner's side, whose allowlist today reads "nothing irreversible may
dispatch for it".

## Entry Points

- `src/writePath/recordFieldNote.ts:253-255` — the return that parks an unmatched inbound capture; `:238-249` the `resolved`-vs-matcher fork; `:257-277` create-new (`createCustomer` with `sourceCaptureId`); `:389-400` the rung 10 ask gate; `:401-409` `createJob` (reached by a technician channel, or by anything that got past the gate).
- `src/writePath/identityMatch.ts:51-142` — `matchIdentity`: phone (`:62-66`), address (`:67-71`), the technician's own schedule (`:83-135`), else refuse.
- `src/inbound/webhook.ts:257-299` — the email door; `:288-298` flags review only when `!tech` (unknown mailbox).
- `src/calls/worker.ts:131-176` — the phone door; `structure` only for `new_job`; `:161-176` the `unlinked_call` review + push.
- `src/calls/observationPing.ts:38` `drainOneObservationPing` → `src/jobs/plannerPass.ts:97` `runFocusedObservationPass` → `src/teamLead/planner.ts:3665` `runPlanner`.
- `src/teamLead/planner.ts:1407-1444` — the inbound gap block; `:2489` chat-only rail; `:3195-3215` apply guard; `:4110-4175` the moot fact for inbound kinds; `:4596-4610` first gap-less chat send bound to the focus observation.
- `src/teamLead/identity.ts` — `TEAM_LEAD_TOOL_NAMES` (the planner's whole dispatchable surface); `src/mcp/server.ts:1745` `TEAM_LEAD_TOOLS` (its schemas); `:2618-2636` the two-way gate; `:2444` `inboundAskFor`; `:4617` `open_job`; `:4691` `book_visit`; `:2069` `resolutionFrom`.
- `src/teamLead/plannerPrompt.ts:225-256` — "REQUESTS FROM CALLS AND EMAIL", the doctrine paragraph for the two existing inbound kinds.
- `Box_Setup_Stuff/bootstrap-box.sh:739-753` — seat rule 7: what a manager's agent does when the office texts about a call (presumes the customer exists).

## Key Files

- **`src/writePath/recordFieldNote.ts`** — the one door. `RecordFieldNoteInput.resolved: ResolvedIdentity` (`:41-45`, `{customerId?, jobId?, createFrom?}`) is the staged-confirm re-entry; `fallbackPhone` (`:69`) is the only channel-specific identity hook; `structure:false` (`:75`) is L1-only. Dedup (`:155-207`): `getRawCaptureByExternalId` → `captureHasLinkedL2` → duplicate, else orphan-heal reuses the L1 row.
- **`src/db/rawCaptures.ts`** — `captureHasLinkedL2` (`:144-175`): `source_capture_id` on visits/jobs/customers, then `visit_notes`, `job_captures`, **and `observations` of ANY kind** (`captureHasObservation`). `getRawCapture(id)` (`:95`). `listL2CitingCapture` (`:503`): **jobs and visits only** — a customer created from a capture is not "citing" to the planner's moot fact.
- **`src/db/customers.ts`** — `findCustomersByPhone` exact `eq` (`:137`); `findCustomersByAddress` `ilike` exact (`:149`); `searchCustomers` name/phone/address, **no email** (`:164`); `createCustomer` accepts `email` and `sourceCaptureId` (`:6-40`). No `findCustomersByEmail`. No phone normalisation anywhere in `src/` (grep, 2026-09-08).
- **`src/writePath/extract.ts`** — `EXTRACTION_TOOL` (`:77-140`): no `email` property; nothing about quoted history. `Extractor = (rawText, ctx?)` (`:57`).
- **`src/db/observations.ts`** — `PINGED_KINDS` (`:236`, "rung 10b appends `inbound_unmatched` here and every helper below follows"); `captureHasObservation` (`:244`); `listUnpingedObservations`, `claimObservationPing`, `markObservationAsked` (24 h window), `clearObservationAsked`, `stampObservationsPinged`.
- **`src/db/reviewItems.ts`** — `ReviewKind` (`:10-76`): `unlinked_call` (`:35`), `inbound_new_job`, `inbound_commitment`; `openUnlinkedCallReview` (`:190`). The flagNudgeGap precedent (`:150-158`): a kind whose writer is deleted keeps its type and rows.
- **`src/jobs/plannerPass.ts`** — `focusedPassBlockedBy` (`:69`, before the claim); `runFocusedObservationPass` (`:97`): `listObservations=[obs]`, `listOfficeMessages=[]`, tools = `TEAM_LEAD_TOOL_SCHEMAS`, executor `dispatchForIdentity(…, TEAM_LEAD_REF)`.
- **`src/teamLead/identity.ts`** — `TEAM_LEAD_REF = 'spine:team-lead'`; `TEAM_LEAD_TOOL_NAMES` = `spine_read, recall_decisions, read_memory, write_memory, read_job_note, write_job_note, get_customer_context, resolve_date`; header comment: "nothing irreversible or externally visible may ever dispatch for it; enforcement is mechanism (the gate), never prompt text" — written before the 10d ruling.
- **`src/mcp/server.ts`** — `TEAM_LEAD_ONLY_TOOL_NAMES` is DERIVED from `TEAM_LEAD_TOOLS` (`:1920`): a tool with a schema there dispatches for `spine:` and nothing else; `get_customer_context`/`resolve_date` are base tools allowlisted in `identity.ts` with no `TEAM_LEAD_TOOLS` schema (`server.test.ts:7490-7505` pins the pairing, `KNOWN_UNREACHABLE`). `inboundAskFor` matches an asked observation by `context.customerId` (no job) or `context.jobId` — an unmatched ask would have neither.
- **`src/teamLead/desk.ts`** — `DESK_READ_TOOLS` allowlist (`spine_read, recall_decisions, read_memory, read_job_note`): the synchronous `ask_team_lead` path cannot write by construction.
- **`src/schedule/booking.ts`** — `bookVisit(BookVisitInput)` (`:547`), shared by the MCP handler; `customerId + title` mints the job (`:556`), `sourceCaptureId` stamps job and visit (`:572, :584`), no date/times = untimed (`:620`); `actorRef` recorded on the ledger event.
- **`src/writePath/attachNote.ts`** — step 3 creates only for `mayCreate` (technician channels), status `completed` — a walk-in, not a committed visit (`:116-127`).
- **Tests that pin today's behaviour** — `recordFieldNote.test.ts:1176` "(7) an UNMATCHED committed call writes no observation — rung 10b owns the new caller"; `worker.test.ts:238` both branches fire (unlinked + call_action, two pushes); `observations.test.ts:431` `PINGED_KINDS` equals the two kinds; `server.test.ts:7490` allowlist/schema pairing; `src/eval/doctrine.test.ts:219` bare dates in AGENTS.md bodies need a `live finding|user feedback|added|updated|refreshed` marker within 60 chars.
- **Migrations** — `observations.kind` is `text not null`, no CHECK (`20260901130000:38`); `idx_observations_unpinged` has no kind predicate (`20260908100000:34-36`); `uq_observations_subject_ever` is `(tenant_id, kind, subject_ref) where author='detector'` (`20260904110000:80-81`). A new kind needs no migration.

## Data Flows

### 1. An unknown caller by phone, today

```
SignalWire → call_ingest → Calls-worker → classifyCall
   new_job? ──no──► structure:false → L1 only ('captured') → call_action review + push
   └─yes─► recordFieldNote(fallbackPhone = caller ID, E.164)
             L1 → extract → matchIdentity
                phone eq ─0─► address ilike ─0─► schedule branch (ref 'phone-line' has no
                roster row → skipped) ─► needs_disambiguation ─► RETURN (:253)
           worker: openUnlinkedCallReview(kind unlinked_call, subject=captureId,
                   suggestion=caller phone) + notifyManagers("📋 Call — new customer to link")
           call_ingest.match_status = needs_disambiguation
```
The manager's agent sees the item through `list_pending_reviews`. `resolve_review` (`server.ts:6960`)
has no `unlinked_call` branch: resolved or dismissed, nothing else. No tool takes a capture id and
a customer and re-runs the door. A call is never redelivered, so the orphan-heal path never fires.
Pilot firm (manager-sam's tenant), 2026-09-08: 6 `unlinked_call` items, all open; 6 calls parked.

### 2. An unknown emailer, today

```
Composio → /inbound/composio → HMAC → normalizer → roster → classifier → recordFieldNote
   L1 → extract → matchIdentity → needs_disambiguation → RETURN
   webhook: r.status !== 'duplicate' && !tech ? flagReview : nothing   → 200 'ingested'
```
`!tech` is the MAILBOX check. A known mailbox's unknown sender leaves no review, no push, no
observation. A redelivery re-runs the extractor (no L2 link, no observation) and parks again.

### 3. A KNOWN customer parked as a stranger (live, 2026-09-08)

Tom Becker's reply *"Is it possible to do Friday afternoon instead?"* arrived on the same thread as
the email that booked his Friday visit. `metadata.threadId` = that email's `external_id`. The
door parked it: the extractor read no phone from the quoted history (it read one from the
original's fresh body), the customer has no email on file, and the matcher has no thread key.
0 observations, 0 `job_captures`, 0 `visit_notes`. The manager was not told a customer wants the
visit moved. Record: `2026-09-07-email-thread-context-from-composio.md` flow 5.

### 4. The door's re-entry, `resolved`

```
record_field_note (seat, staged confirm) ── resolutionFrom(match, confirmed, extracted)
   → recordFieldNote({ …, resolved: { customerId } | { createFrom: draft } })
       (1) L1 append — a NEW capture, externalId `note:<hash>`; stamped customerId at the append
       (4) match := resolved (matcher skipped)
       (5) createCustomer({ name, phone, address…, sourceCaptureId: captureId })  ← cites the capture
       gate: !isTechnicianChannel && !job → ask (observeInbound) or file  ← channel is the CAPTURE's
```
Two facts for re-entering with an EXISTING capture: (a) `captureHasLinkedL2` counts an observation
of any kind as "processed", so a capture that already carries an `inbound_unmatched` row would
short-circuit as `duplicate` on the externalId path; (b) `getRawCapture(id)` exists, but nothing
today builds a `RecordFieldNoteInput` from a stored row (text = `raw_text`, channel, technicianRef,
`sourceMeta` = metadata, externalId). The channel stays the capture's, so a resolved email re-run
still hits the rung 10 gate: with no open job and no `decided` signal it would raise
`inbound_new_job` — a second ask about the same message.

### 5. The ping loop and the focused pass (kind-blind by name)

```
observation(kind ∈ PINGED_KINDS, pinged_at null, asked_at null)
  → Calls-worker: focusedPassBlockedBy() → claimObservationPing → runFocusedObservationPass
  → runPlanner(focus, listObservations=[obs], listOfficeMessages=[], tools=TEAM_LEAD_TOOL_SCHEMAS)
  → gap block (:1407): words, from, customer line IF context.customerId, "they asked for", on-file
    job line, "the firm agreed to come out", capture id, "you have already texted a manager"
  → decisions: send (as:"chat" only for PINGED_KINDS; countsAsTheAsk refused; first gap-less chat
    send bound to the focus obs → markObservationAsked, 24 h re-ask window) · hold · dismiss ·
    close basis "record" via mootFact — listL2CitingCapture: a JOB or VISIT citing the capture
```
The gap block assumes a customer exists (`customerId` line optional; "on file: no open job for
this customer" otherwise). The moot fact cannot see a created CUSTOMER.

### 6. Who can write what, today

| actor | creates a customer | opens a job | books a visit | cites the capture |
|---|---|---|---|---|
| the door, technician note | yes (`resolved.createFrom`) | yes | walk-in (completed) | `source_capture_id` |
| manager's agent | only via a NEW staged note (`record_field_note`) | `open_job` | `book_visit` (untimed OK) | `inboundAskFor` by `context.customerId`/`jobId` — an unmatched ask has neither |
| the planner | no | no | no | — |

The planner's in-loop writes are `write_memory` and `write_job_note`, admitted in `identity.ts` as
"not irreversible, not externally visible". A customer or job row pinned by an L1 capture is
permanently undeletable (`l1-pins-l2-undeletable`).

### 7. How a manager's answer travels back

`send` → `office_messages` (queued) → seat runner delivers verbatim (~60 s) → manager replies to
their seat → the seat either acts with its own tools (rung 10: `open_job`/`book_visit`, rule 7)
or `inform_team_lead` (read at the next planner pass — up to 30 min until rung 10c) or
`ask_team_lead` (the desk, read-only allowlist, answers now, cannot act). The seat holds no
observation id and no capture id; the office's text is prose.

## External Dependencies

- **Composio Gmail** — trigger payload carries `thread_id`/`to`/`label_ids` (captured since PR #213); `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` returns a thread in ~0.7 s under the mailbox's own account; polling trigger, INBOX only. See `2026-09-07-email-thread-context-from-composio.md` for citations.
- **SignalWire** — caller ID arrives as `From` (E.164, `+1…`, `phoneWebhook.ts:59`); a customer created from a call carries that exact string.
- **The extractor model** — `defaultExtractor` via `runForcedTool` (GLM on the web service; `INFERENCE_MODEL` on the Calls-worker). Its output is the only source of `phone`/`address` for matching.

## Constraints and Invariants

- **Unique-or-refuse is the matcher's whole posture.** Phone: exact string, no normalisation. Address: case-insensitive exact on line 1. Pilot-wide, addresses are not unique (505 Broadway E ×3, 412 Dexter Ave N ×2); on manager-sam's tenant 37 of 47 customers have an address (all distinct), 2 a phone, 1 an email. The `email` column exists on every row and is never consulted.
- **The extractor reads the fresh text.** Live, once: a phone string present in quoted history was not extracted. No `email` field exists in its schema.
- **A thread starter's thread id is its own message id** — so `metadata.threadId` of a reply equals an earlier capture's `external_id` when the starter was captured; captures before PR #213 carry no `threadId` and cannot be the reply side.
- **`captureHasObservation` is a processed marker for ANY kind**, and the once-ever index is per `(tenant, kind, subject_ref)` for detector rows: two kinds for one capture are permitted by the DB, forbidden by the dedup (recordFieldNote.ts:302-308).
- **`idx_observations_unpinged` and the ping helpers are kind-free**; `PINGED_KINDS` is the only list. Adding a kind touches: that list, the `observations.test.ts:431` pin, and every `PINGED_KINDS` consumer's assumptions (gap block, chat-only rail, apply guard, moot fact, pinged stamp).
- **The chat-only rail and `countsAsTheAsk` refusal apply to every pinged kind**; every inbound observation has `technician_id: null`.
- **A tool in `TEAM_LEAD_TOOLS` dispatches for `spine:` ONLY** (derived set). A tool both a manager's seat and the planner may call must sit in the base/admin list AND in `TEAM_LEAD_TOOL_NAMES`, with a schema the planner loop is handed — the `get_customer_context` shape, which the pairing test currently lists as `KNOWN_UNREACHABLE`. The `identity.ts` header rule ("nothing irreversible") is prose over a mechanism; the mechanism is the allowlist.
- **`bookVisit` is shared and cites**: `sourceCaptureId` lands on the job it mints and the visit; `customerId + title` mints the job; no date/times = untimed `confirmed`; it refuses a second untimed visit on the same job and a `customerId` booking when open work exists (`forceNewJob`).
- **The door's gate keys on the capture's channel, not the caller's intent.** A re-run of an inbound capture with `resolved` set still asks unless something says the decision was made.
- **Retiring a writer keeps the kind.** `unlinked_call` rows exist (6 open on the pilot); the type and `list_pending_reviews` keep reading them (the `flagNudgeGap` precedent).
- **The phone door structures `new_job` only**; every other intent is L1-only plus a `call_action` review. `web_form` exists only as an eval fixture (`src/eval/worldSpec.ts:628`).
- **Office messages do not wake the planner** (`plannerCadenceDue`; rung 10c pending); the desk cannot write.
- **A focused pass claims before it runs and nothing releases a claim**; `focusedPassBlockedBy` runs first (the 401-day trap).
- **Doctrine edits to `bootstrap-box.sh` need a dated marker** (`doctrine.test.ts:219`), and the box's seven divergent bootstrap copies are md5'd before any wire.

## Decision Points

1. **Scope of the plan.** The new-caller path alone, built with the planner making the write through the one door (its first L2 write), or the whole of 10d (planner-side open/book/move/unschedule/cancel/money/edit-customer) with the new-caller path last. The ladder says one plan; the 300-line plan limit says how much fits.
2. **Identity keys and their order.** Today: phone → address. Candidates: the From address as email's caller-ID (`fallbackEmail`, unique-or-refuse, parsing `"Name <addr>"`); `metadata.threadId` → an earlier capture on that thread → its customer (via `job_captures`/`visit_notes`/`source_capture_id`/stamped `customer_id`); phone normalisation. Which wins when two keys point at different customers is undecided in code.
3. **What raises `inbound_unmatched`.** Phone: `new_job` calls only (today's structure gate) or every intent. Email: every work email that matched nobody, or not when `touchesOperations === false` (a stranger's thank-you). Whether the observation carries near-misses (same name, shared number) for the planner's second opinion.
4. **Who acts on the manager's "yes".** The planner, after the seat relays with `inform_team_lead` (up to 30 min until 10c; the seat must say "passed to the office", not "done"); or the manager's seat as well, through a shared tool — which then needs a handle the seat does not have (no observation id; `inboundAskFor` keys on a customer that does not exist yet).
5. **How far the write goes in one call.** Identity only (link or create); plus the job (else the door's gate raises `inbound_new_job` on the re-run — a second text about the same call); plus an untimed visit through `bookVisit` when the firm committed (else `inbound_commitment` is raised on the new job and rung 10's path books it from a second text).
6. **Re-entering the door for an existing capture.** Exclude `inbound_unmatched` from `captureHasObservation`'s processed marker (a redelivery then re-extracts, as unmatched captures did before rung 10), or add a capture-id entry to `recordFieldNote` that bypasses the externalId dedup, or build the input from `getRawCapture` and pass a new `decided` shape.
7. **Where the chain comes from at extraction.** Assemble from L1 by `threadId` (no network; blind to pre-pairing mail and app-sent replies), fetch per email (`GMAIL_FETCH_MESSAGE_BY_THREAD_ID`, ~0.7 s, billed, inside the webhook request), or both; and how it reaches the extractor (a context argument vs the stored text).
8. **Tool placement and name.** In `TEAM_LEAD_TOOLS` (team-lead-only, the `write_job_note` shape) or shared with the manager tier; the `identity.ts` header rule to amend; the pairing test to extend.
9. **What closes the new kind on THE RECORD.** `listL2CitingCapture` reads jobs and visits; a customer created from the capture is invisible to the moot fact unless the reader learns `customers`.
10. **Rendering a customer-less observation.** The gap block's customer and on-file lines assume one; what the planner is shown instead (the From, the extractor's name/phone/address, candidates).
11. **The retired push and the open items.** Six open `unlinked_call` rows on the pilot: left as they are, resolved by hand, or re-raised as `inbound_unmatched`.
12. **Seat doctrine.** Rule 7 presumes a customer; the relay line for a caller nobody has on file, and the honest-reporting rule, ride the next wire pass (deferred by the user).

## Open Questions

- Does the extractor ever read a phone or address out of quoted history? One live observation says no; nothing pins it either way.
- How often do two customers share a number on a real firm (spouses, a property manager)? The pilot's phone column is too thin (2 of 47) to say; unique-or-refuse assumes it happens.
- Can `bookVisit` run under `TEAM_LEAD_REF` as `actorRef`? Nothing in `booking.ts` checks the ref against the roster; the ledger event would carry `spine:team-lead`. Untested.
- Does a webhook redelivery of a parked email ever happen in practice, and how often? It is the only path that would re-extract today.
- What `payload`/`preview` in the trigger carry (RFC headers?) — unopened, from the thread research.
