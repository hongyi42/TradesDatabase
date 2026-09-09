---
date: 2026-09-09
task: the thread supplies the JOB when a person key found the customer; and the firm's own half of an email conversation finally reaches the record
research: thoughts/shared/research/2026-09-09-who-may-write-l2.md
status: draft
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
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] the two-open-jobs test fails on `main` and passes here

### Manual verification
None.

---

## Phase 2: the firm's own replies reach the record, gated

### What this phase does
Captures a human's outbound email through the same door as everything else, behind the
work/personal classifier, without duplicating the assistant's own sends.

### Changes required

**`src/composio/pairing.ts`**
- `ensureTrigger`'s `triggerConfig` gains `SENT` alongside `INBOX`. Confirm the exact multi-label
  syntax against Composio's live trigger-type schema before writing it — CLAUDE.md's external-doc
  rule applies, and `labelIds` is a comma string today, not an array.
- **Existing triggers do not pick this up.** `ensureTrigger` returns an existing trigger's id
  without reconfiguring it, so every already-paired seat keeps the INBOX-only trigger. Either the
  trigger is recreated for those seats, or this phase ships inert. Decide in implementation and
  record which; the pilot has exactly one paired account and it is on the wrong roster row (rung
  13), so this interacts with that.

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

**tests**
- a SENT message whose `sent:` twin exists → `duplicate`, nothing written;
- a SENT message with no twin, classified WORK → captured as `outbound_email`, filed on the job;
- a SENT message classified PERSONAL → dropped with a receipt, nothing in L1 (the ruling);
- `send_email` with `jobId` → capture stamped; without, unique recipient → stamped; ambiguous
  recipient → unstamped, no throw;
- `findCustomersByThread` now identifies a customer from a firm-started thread.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] the new tests above pass

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP, the deployed pilot, the trigger reconfigured for at least one
  seat
- [ ] a manager replies from Gmail directly → the capture appears as `outbound_email` on the right
      job — evidence: the row plus its `job_captures`/`visit_notes` link
- [ ] a personal email sent from the same mailbox → NOT in `raw_captures`, present in
      `dropped_audit` — this is the ruling's whole point and must be proven, not assumed

### Manual verification
None.

---

## Phase 3: the live verification, including 10b.2's deferred tests

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
- [ ] read-backs for each step above

### Manual verification
- [ ] the job's correspondence now reads as a conversation with both halves in it

---
*Pause after Phase 3's manual item.*
