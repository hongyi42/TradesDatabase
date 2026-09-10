---
date: 2026-09-09
task: the thread supplies the JOB when a person key found the customer; and the firm's own half of an email conversation finally reaches the record
research: thoughts/shared/research/2026-09-09-who-may-write-l2.md
status: complete
supersedes: nothing
---

`supersedes: nothing`. It does not overturn a decision. It NARROWS one recorded fact — the
2026-09-08 memory line "app-sent human replies never arrive (INBOX-only)" was filed as a testing
footnote; this plan treats it as a hole in the record, which is what it is.

## Overview

Two findings from 2026-09-09, both surfaced by the user asking questions the live e2e could not,
and both about the same thing: **an email conversation is only half in the record.**

**(1) The thread knows which job, and is never asked.** `matchIdentity` returns `{customerId}` from
phone/email/address and `{customerId, jobId?}` from the thread — the thread is the ONLY key that
knows the job. But the keys run phone → email → thread → address with an immediate return on a
unique hit, so a person key match discards the thread's answer before it is computed. The door then
guesses: the customer's most recently created non-terminal job. A customer with a quote outstanding
AND a repair booked, replying about the older one, is filed against the newer — cited, on the right
person, looking entirely correct.

**(2) The firm's own replies are invisible.** Every seat's Gmail trigger is
`{ interval: 1, labelIds: 'INBOX', userId: 'me' }` (`src/composio/pairing.ts:247`). A manager
replying from Gmail directly is never captured — not filtered, not dropped, never delivered. So a
job's correspondence is one-sided; the planner cannot tell whether anybody answered; and a promise
typed by hand ("we'll come Thursday") binds the firm while the spine has no idea. That is exactly
what rung 10 exists to catch, arriving through a door rung 10 does not watch.

They compound: the extractor's thread context falls back to our own L1 view, which holds only
inbound halves, so "earlier in this conversation" is missing the firm's side.

## Decisions

- **The thread's job is adopted ONLY when it belongs to the already-matched customer.** The hazard
  is the reason this needs writing down: a person key matches customer A while the thread's job
  sits on customer B, and adopting it blindly files against the wrong customer's work — worse than
  the bug being fixed. Person keys keep deciding WHO; the conversation only ever decides WHICH.
- **A human's own sent mail enters L1 GATED** by the work/personal classifier (user, 2026-09-09).
  L1 has no delete, so a manager's dentist appointment must never be written; the classifier is the
  only thing standing between the two.
  - *Implementation, and it needs a ruling.* The classifier was written for inbound: it sees the
    sender only and its standing rule is "when unsure, prefer isWork=false". On a SENT message the
    sender is always the firm, so *"Thursday works — we'll come out then."* — nine words, `Re:`
    subject, no trade vocabulary — reads as unsure and is DROPPED. That is this rung's headline
    case failing its own gate. **What shipped:** the prompt names the direction and shows `To:`
    (the only real signal on outbound mail), and says brevity is not evidence of personal.
    **What did NOT ship:** inverting the tie-break to "prefer isWork=TRUE for outbound". It
    contradicts the standing sentence in the same prompt, and it softens exactly the safeguard this
    ruling is about. **OPEN — for the user:** if live verification shows real replies still being
    dropped, the inversion is the next lever, and it is a change to the terms of this ruling.
- **The 2026-07-04 agent-send exception STANDS.** Sends made by the agent (spine `send_email`,
  Composio executions via `logIngest`) remain classifier-free, because an audit record matters most
  exactly when the action was inappropriate. The ruling above is about a HUMAN's own outbound mail,
  which is a different thing. Flagged to the user 2026-09-09; say so if it was meant to be wider.
- **The `send_email` capture keeps its own row; the SENT-label delivery is DEDUPED against it.**
  The agent's capture is written synchronously and is guaranteed; the trigger's copy arrives about a
  minute later and can fail. Keeping the synchronous one and dropping the duplicate is the safe
  order. Dedup on the Gmail message id: `send_email` stores `sent:<messageId>`, the trigger delivers
  `<messageId>`, so the SENT path checks for the `sent:` form before appending. **Do NOT change
  `send_email`'s externalId** — existing rows carry the current shape and L1 cannot be rewritten.
- **`send_email`'s capture gets stamped, by BOTH routes.** An optional `jobId` argument when the
  agent has one (explicit, and doctrine tells it to pass it), falling back to resolving the customer
  from the recipient address when it is unique. Chosen over either alone: the argument is
  forgettable, and address resolution is wrong exactly when the address is ambiguous — together they
  cover each other, and neither can fabricate (a non-unique address resolves to nothing).
- **Tests A and B of rung 10b.2 are DEFERRED to this rung's verification** (user, 2026-09-09).
  Test A already passed on 2026-09-09 (customer, job and visit all citing capture `64707540`, no
  re-typed L1 row). Test B — the conversation key in isolation — is re-run here, where it also
  exercises the new job-selection path. Iris Calloway's row is deliberately keyless
  (`phone`/`email`/`address_line1` all NULL) as scaffolding for it.

## Plain-language walkthrough

**Phase 1 — the conversation decides which job.** Today two different questions share one answer:

```
  phone / email / address  →  "this is Iris"                    ← WHO
  the thread               →  "this is Iris, about the radiator" ← WHO *and* WHICH

  today:  email matches → return immediately → thread never asked
          → job = whichever of Iris's open jobs is newest      ← a guess

  after:  email matches → still decides WHO
          → then ask the thread, purely for the job
          → adopt it only if that job is Iris's
```

You would notice it working when a customer with two open jobs replies about the older one and the
message lands there instead of on the newer.

**Phase 2 — the firm's half of the conversation reaches the record.** Right now the record holds
what customers say and, unless the assistant sent it, nothing the firm says back. After this, a
manager's own reply from Gmail is captured too — but only if a classifier reads it first and says
it is work. Personal mail is never written, because the log cannot be edited afterwards. The
assistant's own sends are unaffected; they are already captured, and the duplicate copy the trigger
would deliver is recognised and dropped.

**Phase 3 — prove it live, including the two tests held over from 10b.2.**

## Secrets & env preflight

- **Phase 1:** none.
- **Phase 2:** none new. The trigger change is a Composio trigger config, applied per seat by
  re-running the pairing path — no new key.
- **Phase 3:** the deployed pilot, plus the gateway restart / `wire` step that rung 10b.2 recorded.

---

## Phase 1: the conversation decides which job

### What this phase does
Lets a person-key match keep deciding who, while the thread supplies the job it already knows.

### Changes required

**`src/writePath/identityMatch.ts`**
- The person-key arms (`phone`, `email`, and the `address` arm below the thread) stop returning a
  bare `{ customerId }`. Introduce one helper used by all three:
  ```ts
  // The thread knows the JOB; a person key only ever knew the person. Ask it —
  // and adopt its job ONLY when it sits on the customer we just matched, or a
  // reply on a thread that drifted to another customer would file this message
  // against somebody else's work.
  const withThreadJob = async (customerId: string): Promise<MatchResult> => {
    const threadId = input.threadId?.trim();
    if (!threadId) return { status: 'matched', customerId };
    const rows = await findCustomersByThread(tenantId, threadId);
    const jobs = new Set(
      rows.filter((r) => r.customerId === customerId && r.jobId).map((r) => r.jobId as string),
    );
    return { status: 'matched', customerId, ...(jobs.size === 1 ? { jobId: [...jobs][0] } : {}) };
  };
  ```
- `findCustomersByThread` already applies the terminal-job rule and the tenant check, so a paid or
  cancelled job never rides along — no extra guard needed, and a test pins that.

**tests (`src/writePath/identityMatch.test.ts`)**
- email matches, thread names ONE job for that customer → the job rides along;
- email matches, thread's job belongs to ANOTHER customer → no jobId (the hazard);
- email matches, thread names TWO jobs for that customer → no jobId (unique-or-nothing);
- email matches, no threadId → unchanged;
- thread names a TERMINAL job → no jobId;
- the end-to-end shape: customer with two open jobs, a reply on the older thread lands on the
  OLDER job (this is the actual defect, and it fails on `main`).

### Automated verification
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test` — 114 files / 2886 tests
- [x] the two-open-jobs test fails on `main` and passes here — verified by stashing
      `identityMatch.ts` alone: 4 of the 8 new tests go red (`expected undefined`),
      the 4 negative ones stay green

### Manual verification
None.

---

## Phase 2: the firm's own replies reach the record, gated

### What this phase does
Captures a human's outbound email through the same door as everything else, behind the
work/personal classifier, without duplicating the assistant's own sends.

### Changes required

**`src/composio/pairing.ts`**
- ~~`triggerConfig` gains `SENT` alongside `INBOX`~~ — **NOT EXPRESSIBLE; corrected in
  implementation.** The live trigger-type schema
  (`GET https://backend.composio.dev/api/v3/triggers_types/GMAIL_NEW_GMAIL_MESSAGE`, read
  2026-09-09) says `labelIds` "Filter messages by a **single** label ID … For complex label
  filtering, use the 'query' parameter instead", and `query` "…**takes precedence over
  labelIds**", with `label:inbox OR label:sent` as its own first example. So the config is
  `{ interval: 1, labelIds: 'INBOX', query: 'label:inbox OR label:sent', userId: 'me' }`.
- **Existing triggers: BOTH, and it is recorded here.** (a) `ensureTrigger` now compares the live
  config and re-upserts a stale one — `triggers.create` posts to
  `POST /api/v3/trigger_instances/{slug}/upsert`, "creates a new trigger instance or updates an
  existing one"
  (docs.composio.dev/reference/api-reference/triggers/postTriggerInstancesBySlugUpsert), so it is
  a reconfigure, never a delete+create (a recreate drops the polling watermark and Composio
  redelivers the backlog,every delivery paying for a classification). `triggers.update` cannot do it —
  that endpoint takes only `{status: 'enable'|'disable'}`. (b) `ensureTrigger` is nevertheless
  UNREACHABLE for a live seat: `checkPairing` returns `no_op` for any state but `invited`, and its
  healing branch requires a missing trigger id. So `scripts/composio-retrigger.mjs`
  (`npm run composio:retrigger -- user=<tenant>:<ref> account=<ca_…>`) reconciles one paired seat,
  dry-run by default. **Whether the upsert updates IN PLACE or mints a second instance is not
  settled by the docs** — the script re-lists after applying and hard-fails with instructions if a
  second instance appears or the id changes.

**`src/inbound/gmail.ts`**
- The normalizer already keeps `label_ids`. Derive the direction from it: a message carrying `SENT`
  is the firm's own. Map it to `channel: 'outbound_email'` rather than `'email'`, so every existing
  reader that distinguishes the two (`AUDIT_CHANNELS`, the extractor's "the firm's own replies"
  rule, `isTechnicianChannel`) keeps working with no edit.

**`src/inbound/webhook.ts`**
- **Dedup against the agent's own send, BEFORE the classifier and before L1.** If a capture already
  exists for `sent:<externalId>` in this tenant, return `duplicate` and write nothing: the assistant
  sent it, it is already on the record, and a second row would be permanent.
- **The classifier gate applies** (user ruling). A SENT message is classified exactly as inbound is,
  and a personal one is dropped with a receipt. `requiresWorkClassifier` stays true for this
  channel — do NOT reuse the agent-send exception, which covers agent actions only.
- The door then runs as normal: identity match (the sender is the FIRM, so the useful key is the
  recipient and the thread — pass `fallbackEmail` from `to`, not `from`, for a SENT message), and
  the capture lands on the job.

**`src/mcp/server.ts` — `send_email`**
- Optional `jobId` in the schema; when present, stamp the capture with that job and its customer.
- When absent, resolve the customer from the recipient address via `findCustomersByEmail` and stamp
  only on a unique hit. Neither route may fabricate: no job, no stamp.
- This is what makes a thread the firm STARTED identify its customer — today that capture is
  stamped with nobody, which is why the thread key is narrow.

**Found in implementation, beyond the plan's list** (each opened by this phase's own new door):

- **`src/inbound/gmail.ts` keys an outbound delivery `sent:<messageId>`, not the bare id.** The
  plan's dedup joined `sent:<id>` to `<id>`, which only covers the SPINE's own sends. A manager
  acting Composio-direct is captured by `logIngest` up to 15 minutes *after* the trigger fires, so
  the two writes would land under two different keys — one email, TWO undeletable L1 rows. One key
  for all three writers collapses them, and makes a plain redelivery free.
- **`src/email/classify.ts` is direction-aware.** Its standing rule is "when unsure, prefer
  isWork=false", and its user message showed the sender only. On a SENT message the sender is
  always the firm, so *"Thursday works — we'll come out then."* — nine words, `Re:` subject, no
  trade vocabulary — reads as unsure and gets DROPPED. That is this rung's headline case failing
  its own gate. The prompt now names the direction, shows `To:` (the only real signal on outbound
  mail), and prefers isWork=TRUE when unsure about the firm's own reply.
- **`src/writePath/extract.ts` is told when the words are ours.** Its identity rule ("never take
  them from your own firm's replies") covered the firm's replies only as EARLIER context. With our
  own reply as the message being judged, our signature block was a candidate customer identity —
  the same failure `isOwnMailbox` exists to prevent, through a new door.
- **An unmatched outbound promise asks.** `recordFieldNote`'s ask gate was inbound-only, so a
  manager promising a visit to somebody not on file bound the firm silently. Outbound now asks —
  but ONLY on `visitCommitted === true`, because the firm writes to suppliers and accountants all
  day and every one of those would be an item to dismiss.
- **The drop receipt keeps the RECIPIENT domain on outbound.** `dropped_audit` stores a domain
  only, and on the firm's own mail the sender's domain is our own on every single row.
- **The pre-check must not swallow OUR OWN half-finished delivery.** One shared key makes the
  lookup self-referential, so an append that landed and then threw before the job link would
  redeliver as a 503 and be answered `duplicate` forever — the promise never reaching the job, with
  no later delivery able to fix it. `captureHasLinkedL2` cannot tell the two apart (an agent's send
  row has no L2 link either), so the PRODUCER is the discriminator: `metadata.sentVia`
  (`send_email`) or `metadata.toolSlug` (`logIngest`).
- **`sent:<id>` is not Gmail's id, and two comparisons needed Gmail's.** The normalizer keeps the
  bare `messageId` on `sourceMeta`. Without it the firm's own reply lands in its OWN "earlier in
  this conversation" block — where the extractor is told a commitment "is already handled", so
  `visitCommitted` is suppressed and neither ask fires. A promise nobody hears, caused by the line
  written to prevent it.
- **`record_caller`'s own-mailbox rule reverses too.** On an `outbound_email` capture `From` is US,
  so the 10b.2 guard would file the FIRM'S OWN ADDRESS on the customer the planner is creating —
  that incident reproduced through the new door, landing on exactly the name-only answer the
  refusal message steers a manager towards.
- **The planner is told the direction.** Reusing `inbound_unmatched` keeps the ping loop and the
  once-ever index working, but the gap renderer said "nobody on file matches this sender" about a
  message the firm itself wrote. It now renders "YOUR FIRM'S OWN reply, sent to …", and the prompt
  has a paragraph for it.
- **Two spellings on BOTH sides of "never show the message to itself".** The thread shown to the
  model comes from Composio (Gmail's bare id) or from our own L1 (the `sent:` storage key), so one
  spelling excludes the message on one path and not the other. The L1 path is the one the pilot
  runs today, and it is exactly where a healing redelivery lands.
- **`record_caller`'s own-mailbox REFUSAL is direction-scoped too**, not just its fallback. Its
  heuristic reads a sole recipient as evidence of our mailbox — the customer, on outbound — so
  unscoped it refuses the very address the ask itself printed, and tells a manager something untrue
  about their own customer.
- **The producer stamp is pinned by the writers' own tests.** One shared `external_id` makes
  `metadata.sentVia` / `metadata.toolSlug` the only thing keeping the door off the agent's own
  sends; `isAgentWrittenCapture` (src/db/rawCaptures.ts) is now the single definition, and the
  `send_email` and `logIngest` tests assert their REAL rows satisfy it — a stubbed test would stay
  green through a rename.
- **`emailAddressOf` shape-checks.** An '@' anywhere used to be enough, so a header the parser
  cannot handle (`Team: jane@x.com;`) came back as a long "address" matching nothing — the message
  silently losing its key rather than saying it has none. `soleRecipientOf` counts DISTINCT
  addresses, so a reply-all listing one person twice still names them.

**tests**
- a SENT message whose `sent:` twin exists → `duplicate`, nothing written;
- a SENT message with no twin, classified WORK → captured as `outbound_email`, filed on the job;
- a SENT message classified PERSONAL → dropped with a receipt, nothing in L1 (the ruling);
- `send_email` with `jobId` → capture stamped; without, unique recipient → stamped; ambiguous
  recipient → unstamped, no throw;
- `findCustomersByThread` now identifies a customer from a firm-started thread.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [x] the new tests above pass

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, the deployed pilot, the trigger reconfigured for at least one
  seat
- [x] a manager replies from Gmail directly → the capture appears as `outbound_email` on the right
      job — evidence: the row plus its `job_captures`/`visit_notes` link
      **PROVEN 2026-09-10 20:14:14Z.** capture `f1e9c37f`, `external_id: sent:1a08cf47d9756ab7`,
      `channel: outbound_email`, from `hhe23360228@gmail.com` to Delphine Warrick, thread
      `1a08cb325c71ae59`; `job_captures` → job `ceb4f676` "Boiler diagnostic". Matched by
      `soleRecipientOf(to)` (on outbound the sender is always us), job named by the thread.
- [x] a personal email sent from the same mailbox → NOT in `raw_captures`, present in
      `dropped_audit` — this is the ruling's whole point and must be proven, not assumed
      **PROVEN 2026-09-10 20:20:01Z.** `dropped_audit` row `sent:1a08cf96bb87dc94`, domain
      `gmail.com`, reason "Personal dinner invitation, unrelated to the trades business."
      `raw_captures` for that message: **0 rows** (also 0 matching its body text anywhere in
      L1). The SENT watcher demonstrably saw the message — `1a08cf96bb87dc94` appears in
      `ti_vVRScPZX84eQ`'s own message list — so this proves the gate runs BEFORE the insert,
      which is the only thing that can work on an append-only table.

### Manual verification
None.

---

## Phase 3: the live verification, including 10b.2's deferred tests

### Evidence so far (2026-09-10)

**Deployed** `2fba38e`: web `/health` reports its own commit (it caught the old instance still
serving for four polls — the trigger response alone would have been read 40s too early);
lifecycle-heart deploy live; Calls-worker auto-deployed.

**The trigger.** `--apply` settled the question the docs could not: Composio's upsert **keys on
configuration**, so changing it MINTED A SECOND INSTANCE (`ti_hSKW81HqamaI` → `ti_F5OHa0V_I7UV`)
and left the old one polling. The script's post-apply re-comparison caught it and said so; the
orphan was deleted by hand. One trigger now carries `query: label:inbox OR label:sent`. It
inherited `history_id: 532744`, so no backlog was replayed.
*Standing:* `manager-sam`'s roster row still records neither account nor trigger id (rung 13), so
nothing would tear this trigger down on offboarding.

**Test B — PASSED.** Reply `827672cd` (`1a088a4e16472d11`) on thread `1a0881c47f5e00bc` from
`hhesecured@gmail.com` → filed on job `95b47086` "Upstairs radiator cold" via `visit_notes` →
visit `8f79b147`; NO unmatched observation. Iris (`6f1c5a5d`) has `phone`/`email`/`address_line1`
all NULL, so the conversation was the only key that could have found her. The job's
`correspondence` now carries both halves, and the extractor wrote *"Customer requested Friday
instead of the proposed Thursday afternoon"* — Thursday appears nowhere in the reply's own words,
so the thread context was read, on the **L1-fallback path** (the roster row has no connected
account, so the Composio fetch never fires). That is the path this rung's round-3 self-exclusion
fix protects.

**A FLAW IN THIS PLAN'S OWN STEP 2, found while running it.** Steps 1 and 2 cannot both work on
one fixture: Test B needs Iris KEYLESS so only the thread can find her, but Phase 1's defect only
fires when a PERSON key matches FIRST and its early return discards the thread's answer. With a
keyless customer the thread arm answers, and the thread arm returned its job on `main` too — so
the two-open-jobs reply proves nothing about Phase 1. The fix costs one field
(`customers.email = 'hhesecured@gmail.com'`) and no extra message: step 3's outbound reply keys on
the RECIPIENT, so it matches Iris by the email key and then has to ask the thread for the job.
Test B is unaffected — it was proven against the keyless row before the update.

### Steps
1. **Test B (held over from 10b.2).** Reply on the "Radiator not heating upstairs" thread FROM the
   customer's account — `hhesecured@gmail.com`, not the pilot inbox, or it lands in SENT and (before
   Phase 2) is never delivered. Iris's row is keyless, so the thread is the only key with anything
   to match on. Expect: filed against her radiator job.
2. **The two-open-jobs case.** Open a second job for Iris, then reply on the radiator thread again.
   Expect: it lands on the RADIATOR job, not the newer one. This is Phase 1's whole point and it
   cannot be proven on a customer with one job.
3. **The firm's own reply.** A manager answers her from Gmail directly. Expect an `outbound_email`
   capture on her job. Then a personal email from the same mailbox: expect a drop receipt and
   nothing in L1.

### Automated verification
- [x] read-backs for each step above — all via `supabase-test` SELECT, evidence recorded below

### Manual verification
- [x] the job's correspondence now reads as a conversation with both halves in it — job
      `ceb4f676` carries the customer's first email, her two replies, the firm's reply, and the
      firm's booking confirmation, all on thread `1a08cb325c71ae59`

**FIXTURE SUBSTITUTION, and why.** Phase 3 above names Iris Calloway. She could not serve: her
row is keyless, and step 2 ("the two-open-jobs case") needs a customer whose PERSON key matches
first, since Phase 1's change is precisely what happens *after* a person match. One fixture
cannot be both. The run used **Delphine Warrick** (`75c21b4a`), created live through the same
unmatched-caller door on 2026-09-10 19:09 and holding `email = hongyi23360228@gmail.com`.

**Live run, 2026-09-10 (all UTC).**
- **Step 1 — thread supplies the job.** Reply on thread `1a08cb325c71ae59` at 20:08:46 (capture
  `c0e6eb3d`) → `job_captures` → `ceb4f676`. No observation raised.
- **Step 2 — the two-open-jobs case, the decisive one.** Decoy job `1959bd8f` "Kitchen tap
  dripping" created on Delphine at 20:10:23, deliberately with no capture on any thread. Second
  reply at 20:11:30 (capture `89f3a785`) → `job_captures` → **`ceb4f676`, not `1959bd8f`**. With
  two open jobs on one customer and the decoy already in place, the thread was the only thing
  that could choose — which is exactly what `withThreadJob` was written to do: the email key
  answers *who*, the thread answers *which job*, consulted after the person match rather than
  instead of it.
- **Step 3 — the firm's own reply, and the personal drop.** Recorded against Phase 2 above.

**Also proven incidentally.** The firm's promise in that outbound mail raised an
`inbound_commitment` item (`100282cc`) two seconds after capture — promise detection on the
firm's OWN mail, impossible before the SENT watcher existed. That item exposed a separate defect
unrelated to this plan (a `book_visit` / `record_caller` doctrine collision, and an item closed
on words while the record was empty); parked as
`20260910-a-promised-visit-was-never-booked-and-th`, not fixed here.

---
*Pause after Phase 3's manual item.*
