---
date: 2026-09-08
task: Rung 10b — the new caller, built the 10d way. Two more identity keys (sender email, Gmail thread) so known customers stop being parked as strangers; an `inbound_unmatched` observation rides rung 10's ping loop; the planner forms the second opinion, texts a manager ONCE with a quiet note to their assistant carrying the item id, and records the caller itself through the one door with its FIRST L2 write tool (`record_caller`: link or create the customer, open the job, book the promised visit untimed); the extractor sees the reply chain, fetched from Composio with an L1 fallback.
research: thoughts/shared/research/2026-09-08-rung-10b-the-new-caller.md
status: draft
supersedes: thoughts/shared/plans/2026-09-06-rung-10-inbound-commits-a-visit-ask-first.md — its Decisions recorded 10b as "the manager's agent runs `add_customer`"; the 10d ruling (user, 2026-09-07: the planner writes L2) replaces the actor. Everything else in that plan stands.
---

**`supersedes:` is not optional bookkeeping.** Only the 10b decision of the rung 10 plan is
overturned, and only its actor: the planner records the caller, not the manager's agent. The
`identity.ts` header rule "nothing irreversible may dispatch for this identity" was a v1 posture,
not a document; Phase 4 rewrites it in place.

## Overview

When a call or an email matches nobody, the door stops (`recordFieldNote.ts:253`): a call opens a
review item and a push no tool can act on, an email leaves nothing. And the matcher knows only
phone and address, exact-string, so a KNOWN customer is parked as a stranger whenever their message
carries neither — Tom Becker's live reply of 2026-09-08 (research flow 3). This plan: (1) email
and thread become identity keys; (2) the unmatched capture becomes an `inbound_unmatched`
observation on the existing ping loop and the dead-end push retires; (3) the planner sees it,
judges it, and asks a manager once — a phone text plus a quiet note to their assistant carrying the
item id, which the refusal at `planner.ts:2489` currently forbids; (4) the planner records the
caller through the one door with `record_caller`, its first L2 write; (5) the extractor reads the
reply chain. Five phases, each shippable alone.

## Decisions

- **Scope** — USER 2026-09-08: 10b the 10d way. One planner write tool through the one door; planner-side move/unschedule/cancel/money/edit-customer come in a second plan of the same shape.
- **Who writes** — USER: the planner only. The seat relays the manager's answer and creates nothing.
- **Reach of one write** — USER: full ceiling (link/create customer, open job, book untimed visit), each an optional argument; the planner chooses per call under ask-first doctrine. We set the ceiling, the planner decides the call.
- **The chain** — USER: fetch the thread from Composio, fall back to our own captures; ingest never fails on it.
- **The pair, not a workaround** — USER: the planner texts the manager AND sends a quiet note to their assistant with the item id in the same turn. The refusal of a non-chat send naming an inbound item is replaced by a marker rule: only the chat text stamps `asked_at`. Reason the refusal existed: a quiet note that stamped the ask would block the real text for a day while the record said the manager was told.
- **Key order** — mine: phone → email → thread → address, each unique-or-refuse. Person keys before the conversation key before the place key; thread carries a job too when the thread's captures name exactly one.
- **Phone normalisation** — mine, OUT: exact-string stays. Needs a generated column + migration (deploys never migrate); not what bit us. Recorded as a follow-on.
- **What raises the kind** — mine: phone on `new_job` calls only (today's structure gate); email on any unmatched work email unless `touchesOperations === false && visitCommitted !== true` (a stranger's thank-you stays L1-only). Technician channels never (the staged-confirm contract).
- **Re-entry by capture id** — mine: `recordFieldNote` gains `captureId` (reuse the stored row, skip the externalId dedup). `captureHasObservation` stays a strict processed marker, so a webhook redelivery is a duplicate, never a second extractor call.
- **`decided`** — mine: absent = rung 10 behaviour (ask); `openJob` present = mint; `bookVisit: true` = book untimed via the shared `bookVisit`; `bookVisit: false` = neither book nor ask.
- **Tool name and placement** — mine: `record_caller`, in `TEAM_LEAD_TOOLS` (team-lead-only, the `write_job_note` shape).
- **THE RECORD** — mine: `listL2CitingCapture` learns `customers` and `job_captures`, and the moot fact counts those two kinds ONLY for `inbound_unmatched` (reviewer: a `link` arm would auto-close every rung 10 commitment ask, because the door links the capture to the job in the same call it raises the ask — `recordFieldNote.ts:568-576`, test (6)).
- **Open pilot items** — mine: the six `unlinked_call` rows stay for hand resolution; the kind and its rows are kept (the `flagNudgeGap` precedent), the writer is deleted.
- **Thread fetch** — mine: skipped for a thread starter (`threadId === externalId`); bounded to the last 8 earlier messages, 600 chars each; identity fields may come from earlier messages, judgments only from the latest.
- **Seat doctrine** — mine: rule 7 gains the relay line; the wire pass stays deferred (user).

## Plain-language walkthrough

```
call/email ─► L1 ─► extractor (+ the thread, Phase 5) ─► match: phone, EMAIL, THREAD, address   (Phase 1)
                                                            │ nobody
                                       inbound_unmatched observation ─► ping loop, seconds         (Phase 2)
                                                            │
                                       planner: second opinion (spine_read v_customers)             (Phase 3)
                                         ├ supplier / spam ............... dismiss
                                         ├ known customer, new number ..... record_caller (link)
                                         └ really new ..................... text a manager ONCE
                                                                            + quiet note to their assistant (item id)
                                       manager "yes" ─► assistant relays with the id ─► planner:
                                       record_caller: create customer [+ open job [+ book untimed]] (Phase 4)
                                       customer, job, visit all cite the capture; item closes on the record
```

**Phase 1** teaches the matcher two more ways to recognise someone: the address the email came
from, and the Gmail thread it belongs to (a reply carries the id of the conversation it answers).
You would notice it because a reply like Tom Becker's lands on his job instead of nowhere.

**Phase 2** turns "nobody matched" into an item on the planner's list within seconds, on the same
loop rung 10 built, for calls and emails alike. The old "Call — new customer to link" push stops.

**Phase 3** shows the planner that item in its own words and lets it decide: dismiss a supplier,
link a known customer at a new number, or ask a manager. When it asks, it sends the text to the
manager's phone and, in the same breath, a quiet note to the manager's assistant carrying the item
id, so the answer comes back stapled to the right call.

**Phase 4** is the planner's first write to the record: `record_caller` re-runs the one door for
that capture with the identity it settled on, opening the job and booking the promised visit when
told to. Every row cites the call. The item then closes on the record, unprompted.

**Phase 5** hands the extractor the conversation, fetched from Gmail through Composio with our own
captures as the fallback, so a phone number quoted three messages up still counts.

## Secrets & env preflight

- **Phase 1–4:** none new. The Calls-worker's `PLANNER_MODE`, inference credentials and `INFERENCE_MODEL` are `already required` for the ping loop.
- **Phase 5:** `COMPOSIO_API_KEY` on the web service — `already required` (pairing, send_email).

## Phase 1: Email and thread are identity keys

### What this phase does
The From address becomes email's caller-ID and a thread's earlier captures name its customer.
Both unique-or-refuse, in the order phone → email → thread → address. No behaviour change for
technician channels or phone calls without a thread.

### Changes required

**`src/email/format.ts`** — add `emailAddressOf(from: string | null | undefined): string | null`: the `<addr>` inside angle brackets, else the whole string if it contains `@`; trimmed, lower-cased; null otherwise (the `senderDomain` precedent, `droppedAudit.ts:19`).

**`src/db/customers.ts`** — after `findCustomersByAddress` (`:149-160`): `findCustomersByEmail(tenantId, email)` using `.ilike('email', escaped)` where `escaped` has `\`, `%` and `_` escaped (reviewer: `_` is common in addresses and is a LIKE wildcard — `a_b@x.com` would falsely match `axb@x.com`, a wrong unique match, worse than none).

**`src/db/rawCaptures.ts`** — `findCustomersByThread(tenantId, threadId): Promise<{ customerId: string; jobId: string | null }[]>`: captures of this tenant where `external_id = threadId` or `metadata->>'threadId' = threadId` (two reads, PostgREST `.eq('metadata->>threadId', …)`); for those capture ids collect (a) the stamped `customer_id`, (b) `job_captures` → `jobs.customer_id`, (c) `visit_notes` → `visits.job_id` → job, (d) `jobs`/`customers` with `source_capture_id` in the set (reuse `listL2CitingCapture` for jobs; one extra read for customers). Return distinct pairs, tenant-checked on every row (the DETAIL_SELECT doctrine).

**`src/writePath/identityMatch.ts`** — `MatchInput` gains `email?: string | null; threadId?: string | null`. Between the phone block (`:62-66`) and the address block (`:67-71`):
```ts
if (email) { const byEmail = await findCustomersByEmail(tenantId, email); if (byEmail.length === 1) return { status: 'matched', customerId: byEmail[0].id }; }
if (threadId) {
  const byThread = await findCustomersByThread(tenantId, threadId);
  const customers = new Set(byThread.map((r) => r.customerId));
  if (customers.size === 1) { const jobs = new Set(byThread.map((r) => r.jobId).filter(Boolean));
    return { status: 'matched', customerId: [...customers][0], ...(jobs.size === 1 ? { jobId: [...jobs][0] as string } : {}) }; }
}
```
Header comment (`:12-15`) restates the order and why.

**`src/writePath/recordFieldNote.ts`** — `RecordFieldNoteInput` gains `fallbackEmail?: string | null` and `threadId?: string | null` (beside `fallbackPhone`, `:69`); pass `email: input.fallbackEmail ?? null, threadId: input.threadId ?? null` into `matchIdentity` (`:243-248`); create-new (`:266-275`) writes `email: draft?.email ?? input.fallbackEmail ?? null` (`ScheduledCustomerDraft` gains `email`, `identityMatch.ts:30-37`).

**`src/inbound/webhook.ts`** — at the `recordFieldNote` call (`:264-290`): `fallbackEmail: emailAddressOf(meta.from), threadId: meta.threadId ?? null`.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [x] `src/email/format.test.ts` (new or extend): `emailAddressOf` on `"Name <a@b.com>"`, `"a@b.com"`, `"nobody"`, `null`.
- [x] `src/writePath/identityMatch.test.ts`: email unique → matched; two customers sharing an email → falls through; thread whose captures name one customer and one job → matched with `jobId`; thread naming two customers → falls through; phone still wins over email.
- [x] `src/writePath/recordFieldNote.test.ts`: an inbound email from a customer's address with no phone in the body → matched, filed on the open job; a reply carrying `threadId` of a capture linked to a job → matched, `job_captures` link on THAT job; the technician staged path unchanged (test at `:581` still passes).

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (read-back), the pilot deployed.
- [ ] After deploy, a reply on the "Friday morning for the water heater" thread from the other test address lands with `job_captures` on Tom Becker's job (read `job_captures` by the new capture id).

### Manual verification
- [ ] none

---

## Phase 2: The new caller becomes an observation; the push retires

### What this phase does
An unmatched inbound capture (call or email) raises one `inbound_unmatched` observation and
returns; the ping loop picks it up unchanged because `PINGED_KINDS` is the only list. The worker's
`unlinked_call` review and push are deleted.

### Changes required

**`src/db/reviewItems.ts`** — `ReviewKind` gains `| 'inbound_unmatched'` after `inbound_commitment` (`:76`) with a comment: subject is the capture id, author detector, no customer on it. Delete `openUnlinkedCallReview` (`:190-203`); keep the `unlinked_call` kind and its rows (comment, the `flagNudgeGap` precedent `:150-158`).

**`src/db/observations.ts`** — `PINGED_KINDS = ['inbound_new_job', 'inbound_commitment', 'inbound_unmatched']` (`:236`).

**`src/writePath/recordFieldNote.ts`** — replace the return at `:253-255`:
```ts
if (match.status !== 'matched' && !input.resolved) {
  const inbound = channel === 'email' || channel === 'phone_call' || channel === 'web_form';
  const skip = extracted.touchesOperations === false && extracted.visitCommitted !== true;
  if (!inbound || skip) return { status: match.status, captureId, suggestion: match.suggestion };
  const obs = await createObservation({ tenantId, kind: 'inbound_unmatched', subjectRef: captureId, technicianId: null,
    context: { captureId, capturedAt, channel, from: fromOf(input.sourceMeta), matchReason: match.reason ?? null,
      visitCommitted: extracted.visitCommitted ?? null,
      asked: { customerName: extracted.customerName ?? null, phone: extracted.phone ?? null, email: input.fallbackEmail ?? null,
        address: extracted.address ?? null, city: extracted.city ?? null, jobTitle: extracted.jobTitle ?? null,
        jobType: extracted.jobType ?? null, followUp: extracted.followUp ?? null, attributes: objectOrNull(extracted.attributes) },
      words: rawText.slice(0, 1500) } });
  return { status: match.status, captureId, ...(obs ? { observationId: obs.id } : {}) };
}
```
`isTechnicianChannel` is computed later (`:281`); this branch tests the inbound set directly. Amend the dedup comment (`:139-152`): an unmatched capture now has a marker.

**`src/calls/worker.ts`** — delete branch (a) (`:159-176`), the `openUnlinkedCallReview` dep (`:45-50`, `:73`) and its import (`:5`). Comment at `:125-130` gains: "an unmatched caller raises `inbound_unmatched`". In `worker.test.ts` drop the `openUnlinkedCallReview` stub and the `flagged` recorder from `makeDeps` (`:65-101`) — an excess property fails typecheck.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] `recordFieldNote.test.ts`: rewrite (7) at `:1176` — an unmatched committed call writes ONE `inbound_unmatched` row with `visitCommitted: true` and `from` = `fromNumber`; an unmatched email writes one with `from` = the sender; a stranger's `touchesOperations:false` email writes none; a technician note (`:581`) writes none; a redelivery of the unmatched email is `duplicate` (the observation is the marker); two deliveries racing → one row (`createObservation` returns null, no `observationId`).
- [ ] `worker.test.ts`: `:152` "unmatched caller → ingested AND flagged once" becomes "…ingested, nothing flagged, no push"; `:238` mixed call → only the `call_action` branch, ONE push.
- [ ] `observations.test.ts:431` pins the three kinds; a new `inbound_unmatched` row is listed by `listUnpingedObservations`.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, pilot deployed, the owner sends an email from an address nobody has on file with a new name and no phone in the body.
- [ ] Within ~15 s: an `observations` row `kind='inbound_unmatched'`, `subject_ref` = the capture id, `pinged_at` set by the Calls-worker (read-back); no `review_items` row for it.

### Manual verification
- [ ] none

---

## Phase 3: The planner sees it, and may send the pair

### What this phase does
The gap block renders a customer-less inbound item, the doctrine tells the planner what the item is
and what to do, THE RECORD can close it once a customer or a link cites the capture, and a quiet
note may name an inbound item without counting as the ask.

### Changes required

**`src/teamLead/planner.ts`**
- Gap block (`:1407-1444`): for `n.kind === 'inbound_unmatched'` print `  nobody on file matches this sender — why: ${matchReason}` instead of the customer line, keep `the caller's words`, `they gave:` (rename of "they asked for" for this kind; `askedFields` unchanged), `the firm agreed to come out: ${context.visitCommitted === true ? 'yes' : 'not said'}` (read the context, not the kind), and `capture id`. Skip the `on file:` line.
- Rail at `:2489-2495`: delete the refusal. Replace with a comment: an assistant-leg send may name an inbound item; it never marks it asked (below).
- Apply guard `:3213-3218`: delete the `as !== 'chat'` refusal (keep the `countsAsTheAsk` one).
- Marker `:3258-3263`: `if (isInboundAsk && d.nudgeId && d.as === 'chat')` — only the phone text stamps `asked_at`.
- Moot fact `:4159-4172`: KIND-AWARE. For `inbound_unmatched` count `customer`/`link` rows too ("a customer was created from this capture" / "this capture was recorded onto a job"); for `inbound_new_job`/`inbound_commitment` keep `job`/`visit` as the only closers.

**`src/db/rawCaptures.ts`** — `L2CitingCapture.kind` gains `'customer' | 'link'`; `listL2CitingCapture` adds a `customers` arm (`source_capture_id in slice`) and a `job_captures` arm (`capture_id in slice`, `kind:'link'`, `jobId`).

**`src/teamLead/plannerPrompt.ts`** — "REQUESTS FROM CALLS AND EMAIL" (`:225-256`): three kinds; `inbound_unmatched` = "nobody on file matches the sender — you are the second opinion: `spine_read v_customers` by name, phone, email, address for a near miss". Rewrite WHAT CAN HAPPEN (`:235-236`): "YOU record the caller with `record_caller` — link when it is somebody we know at a new number or address (no need to ask), create when a manager says so. Opening a job and booking a visit are asked first, and that is strongest for a visit." THE USUAL MOVE (`:238`) for this kind: "send TWO in one turn: `as:"chat"` to a manager, in your words, and `as:"assistant"` to the same manager with the item's id, telling their assistant to reply via inform_team_lead and mention that id when the manager answers. Only the text counts as the ask." WHEN NOT TO: supplier, spam, a wrong number → dismiss. Add to "WHEN A SEAT TELLS YOU SOMETHING" (`:105`): a reply "in reply to your ask on gap X" about a caller is your cue to `record_caller` X.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] `planner.test.ts`: rewrite (14d) at `:6681-6692`, which asserts the deleted refusal, into (c) below; (a) gap block for an `inbound_unmatched` row shows the sender, the reason, "they gave", the commitment line from context, no customer line, no date; (b) `validateDecisions` accepts `send as:"assistant"` naming an inbound item; (c) in apply, an assistant-leg send naming an inbound item does NOT call `markAsked`, a chat send does; (d) a submission with both sends applies both and binds only the chat one in a focused pass (`:4596-4610`); (e) moot fact for `inbound_unmatched` when only a customer, or only a `job_captures` link, cites it; and an `inbound_commitment` on an existing job (linked in the same call) is NOT closed by that link.
- [ ] `src/db/rawCaptures.test.ts`: `listL2CitingCapture` returns the `customer` and `link` kinds.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; the Phase 2 email already on the pilot.
- [ ] The planner's focused pass wrote two `office_messages`: one `via='chat'` to a manager with `nudge_id` = the item, one `via='assistant'`; `observations.asked_at` set exactly once (read-back).

### Manual verification
- [ ] The manager reads the text on their phone and judges it: who called, what they want, the one question. (Owner as manager-sam.)

---
*Pause after this phase: its Manual verification is non-empty.*

## Phase 4: `record_caller` — the planner's first write through the one door

### What this phase does
A team-lead tool re-runs `recordFieldNote` for an existing capture with the identity the planner
settled on and what was decided, so customer, job and untimed visit all cite the call. The seat's
rule 7 gains the relay line.

### Changes required

**`src/writePath/recordFieldNote.ts`**
- `RecordFieldNoteInput` gains `captureId?: string` (re-entry: `getRawCapture`, tenant check, reuse the row, skip step (1)'s externalId dedup — but NOT the retraction guard: refuse when `findRetractionsFor([captureId])` is non-empty, the `:162`/`:199` rule) and `decided?: { openJob?: { title?: string | null; jobType?: string | null }; bookVisit?: boolean }`.
- Gate at `:389-400`: `if (!isTechnicianChannel && !job && !input.decided?.openJob)` keeps today's ask/file; with `openJob` present fall through to `createJob` (`:401-409`) using `decided.openJob.title ?? extracted.jobTitle`.
- Commitment at `:481-484`, mirroring `asked`'s `!visit` condition: `bookVisit === true && !visit` → `await bookVisit({ tenantId, jobId: job.id, sourceCaptureId: captureId, actorRef: TEAM_LEAD_REF, reason: 'record_caller' })` (untimed; import from `../schedule/booking.js`, no cycle — it imports only `../db` and `./availability`), result carried as `visitId`; a live visit already attached → book nothing, report it; `bookVisit === false` → no ask; absent → today's `observeInbound(job)`. The dispatch refuses `bookVisit:true` without `openJob` unless the customer has an open job — otherwise the gate at `:389-399` would raise a second observation and the tool would report success with nothing booked.

**`src/mcp/server.ts`**
- `TEAM_LEAD_TOOLS` (after `write_job_note`, `:1874-1897`): `record_caller` — `observationId` (required), exactly one of `customerId` / `newCustomer { name (required), phone, email, addressLine1, city, state, postalCode }`, optional `openJob { title, jobType }`, optional `bookVisit` (boolean). Description: what it does, that it cites the capture, that a link needs no manager, that a job or visit is asked first.
- Dispatch case (beside `write_job_note`, `:5905`): load the observation (`getObservation`? — add `getObservationForTenant(id, tenantId)` to `observations.ts` if absent), require `kind === 'inbound_unmatched'` and `status === 'open'`; customer tenant guard (`getCustomer`, the `open_job` precedent `:4623-4625`); `newCustomer` → `resolved: { createFrom: {...} }` (`ScheduledCustomerDraft` shape; `email` added to that interface in `identityMatch.ts:30-37` and to `createCustomer` call at `:266-275`); refuse a row whose `technician_ref` is null (typed `string | null`, `database.types.ts:1574`); call `recordFieldNote({ tenantId, technicianRef: row.technician_ref, channel: row.channel, text: row.raw_text, blobPath: row.blob_path, captureId: row.id, sourceMeta: row.metadata, fallbackPhone: metadata.fromNumber ?? null, fallbackEmail: emailAddressOf(metadata.from), threadId: metadata.threadId ?? null, resolved, decided })` so a created customer carries the caller's number/address, and Phase 1's keys recognise them next time; before the call read `listL2CitingCapture([row.id])`: a `customer` row → refuse `newCustomer` (steer to `customerId`), a `job` row → drop `openJob` (a retry after a downstream throw must not mint twins — L1-pinned rows are undeletable); return `{ customerId, jobId?, visitId?, note: 'the item closes on the record at your next pass' }`.

**`src/teamLead/identity.ts`** — add `'record_caller'` (`:54-57`); rewrite the header rule: the planner writes L2 under the 10d ruling; every write cites a capture; ask-first is doctrine.

**`Box_Setup_Stuff/bootstrap-box.sh`** rule 7 (`:739-753`) gains: "If the office says nobody on file matches the caller, do NOT create the customer: put the question to the manager, then relay their answer with inform_team_lead, mentioning the id the office's note gave you (it may arrive after the text — include the caller's number as the office wrote it). Say you passed it on, never that it is done. (added 2026-09-08)". Mirror in `docs/nemoclaw-tech-agent.md`. Wire pass deferred.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` (`doctrine.test.ts` passes: the bullet carries `added`).
- [ ] `recordFieldNote.test.ts`: re-entry by `captureId` reuses the row (no second L1 row); `decided.openJob` mints a job citing the capture with no observation; `bookVisit:true` books an untimed `confirmed` visit citing it; `bookVisit:false` books nothing and asks nothing; `decided` absent on a committed re-run raises `inbound_commitment` on the job (rung 10 unchanged); `createFrom.email` lands on the customer.
- [ ] `server.test.ts`: `record_caller` dispatches for `spine:team-lead` and is refused for a manager badge (`TEAM_LEAD_ONLY`); refuses a foreign tenant's observation and customer; refuses an item that is not `inbound_unmatched`/open; refuses `newCustomer` when a customer already cites the capture and skips `openJob` when a job does (idempotent retry); the pairing test (`:7490`) passes. Add the name to the two exact-list pins: `server.test.ts:7122-7129` and `src/eval/toolCases.test.ts:66-75` (it scans `server.ts` source).

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; Phase 3's live item; the owner answers the text "yes, new customer, open the job".
- [ ] After the relay and the planner's next pass: a `customers` row and a `jobs` row with `source_capture_id` = the capture, the observation closed on the record (`nudge_decisions` row `action='close', basis='record'`), no second `office_messages` chat row to the manager.

### Manual verification
- [ ] none (the relay is the seat's behaviour and rides the deferred wire pass; until then the owner may relay by hand in the seat's chat).

---

## Phase 5: The extractor reads the chain

### What this phase does
For an email that is not a thread starter, the webhook fetches the thread through Composio under
the mailbox's own connected account and hands the earlier messages to the extractor as context;
if the fetch fails, the earlier messages come from our own captures on that thread.

### Changes required

**`src/composio/threads.ts`** (new) — `fetchThreadMessages(tech, threadId, deps)`: `client.tools.execute('GMAIL_FETCH_MESSAGE_BY_THREAD_ID', { connectedAccountId, userId: compositeUserId(tech), arguments: { thread_id }, dangerouslySkipVersionCheck: true })` (the `outbound.ts:49` shape); `recordComposioCall` with the `billed` flag (`pairing.ts:157-175`); map `data.messages[]` → `ThreadMessage { messageId, from, to, subject, body, at }`; return `null` on any failure (advisory, logged). Export the `ThreadMessage` type.

**`src/db/rawCaptures.ts`** — `listCapturesByThread(tenantId, threadId)` (the Phase 1 read, returning rows) → `ThreadMessage[]` via `metadata.from/to/subject`, `raw_text` body, `captured_at`.

**`src/writePath/extract.ts`** — `Extractor = (rawText, ctx?, context?: { earlier: ThreadMessage[] })`; `renderThreadContext(earlier)`: last 8, oldest first, each `From/Subject/at` + body cut to 600 chars, under "EARLIER IN THIS CONVERSATION (context only)"; `defaultExtractor` prepends it and labels the current text "LATEST MESSAGE — extract from this". `EXTRACTION_SYSTEM` gains one sentence: identity details (phone, address, email) may be read from earlier messages; `jobTitle`, `statusSignal`, `visitCommitted`, `touchesOperations` describe the latest only.

**`src/writePath/recordFieldNote.ts`** — input gains `threadContext?: ThreadMessage[]`; passed as the extractor's third argument (`:226`).

**`src/inbound/webhook.ts`** — after the classifier, when `meta.threadId && meta.threadId !== envelope.externalId && tech?.composio_connected_account_id`: `earlier = (await fetchThreadMessages(tech, meta.threadId)) ?? (await listCapturesByThread(tenantId, meta.threadId))`, minus the current message id; pass as `threadContext`. Injectable via `InboundWebhookDeps.fetchThread`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] `extract.test.ts`: `renderThreadContext` bounds (8 messages, 600 chars, oldest first) and the "LATEST MESSAGE" label; the system sentence pinned.
- [ ] `webhook.test.ts`: a starter (`thread_id === message_id`) fetches nothing; a reply fetches once and passes `threadContext` (stub returns two messages, current one excluded); a failing fetch falls back to the L1 read; the ingest result is `ingested` either way.
- [ ] `src/composio/threads.test.ts`: response mapping and the cost record on `successful:false`.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, `COMPOSIO_API_KEY` on the web service, pilot deployed.
- [ ] A reply on the water-heater thread with NO phone in the fresh text: the capture matches Tom Becker (Phase 1 would too); Render request log for `/inbound/composio` shows one request; Composio's execution log (dashboard, or `npm run` log ingest) shows one `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` for the pairing; `composio_calls` cost row recorded.

### Manual verification
- [ ] none
