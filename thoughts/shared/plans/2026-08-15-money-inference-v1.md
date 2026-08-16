---
date: 2026-08-15
task: Money ledger v1 (part B) — evidence-class-tiered money inference (email + notes), assert-only-cited reads, reconciliation digest, probably-done nudge, docs/disclosure
research: thoughts/shared/research/2026-08-15-pricing-invoicing-payment-loop.md
status: draft
depends: thoughts/shared/plans/2026-08-15-money-ledger-v1.md (part A — implemented 2026-08-15)
amended: 2026-08-15 — trust-bend (user decision): spine ≠ the books; evidence-class-tiered
  writes; note source; assert-only-cited reads; weekly digest. Part D companion:
  2026-08-15-accounting-ingestion-direction.md. Reviewed same day; findings folded in.
---

## Overview

Part A built the ledger and the manager tool. This plan makes the money picture fill itself in
**without the manager having to volunteer anything** — while structurally preventing the failure
that kills trust: the agent asserting a money figure the manager knows is wrong. The governing
frame (user decision 2026-08-15): **the spine is not the books.** It is an evidence-linked money
memory that reconciles against the firm's real books (or head); accounting-grade truth arrives
later via an accounting connector (part D direction doc). Inference therefore optimizes
PRECISION over recall: a missing number is an honest gap, a wrong number is a trust incident.

## Decisions

- **The spine is not the books** (user, 2026-08-15) — we present evidence, not balances-as-fact.
  An incomplete picture is stated as incomplete ("no payment on record"), never converted into a
  confident claim ("they owe $450"). Accounting-grade numbers come from the firm's own money
  system when connected (part D); inference is the bridge and the cash-detector, not the endgame.
- **Evidence-class-tiered writes** (user, 2026-08-15) — what may auto-enter the ledger depends on
  whose artifact the evidence is:
  - **Class 1 — the spine performed it** (part C sends an invoice): recorded synchronously by the
    acting code path as fact. Not inference's job (the `metadata.invoiceNumber` skip below).
  - **Class 2 — the manager's own outbound artifact** (an email THEY wrote saying "$450"):
    auto-record + immediate disclosure. Correcting it would mean correcting themselves.
  - **Class 3 — everything else** (field notes, inbound mail, transcripts): NEVER auto-recorded.
    Becomes a `money_event_suggestion` review item; the ledger entry is created only when the
    manager confirms (recorded manager-attributed). The ledger therefore only ever holds
    human-entered, spine-performed, or manager's-own-artifact numbers — an inference-vs-head
    discrepancy is structurally impossible for Class 3.
- **Auto-record cap** — even Class 2 degrades to a suggestion above
  `MONEY_AUTO_RECORD_CAP_CENTS` (constant, default 1_000_000 = $10,000): a five-figure line item
  never appears without a question. (A future firm-profile setting; a constant now.)
- **Assert-only-cited reads** — manager money reads carry provenance (each `recentEvents` entry
  gains `actorRef` + `evidence: 'manager' | 'spine' | 'inferred'`), and the money-read tool text
  instructs the agent: attribute figures to their evidence ("from your email Tue"), state absence
  as absence, never as debt.
- **Inference sources v1: outbound email (Class 2) + field notes (Class 3).** Notes added by user
  direction — they are the ONLY channel where cash appears, and attribution is free (a note
  already resolves to its job). Tech notes never write the ledger directly (tier policy holds).
  Deferred: inbound email (incl. processor receipts), call transcripts, non-email connectors
  (keys-only redaction — each needs a reviewed per-toolkit policy), accounting ingestion (part D).
- **Note-path detection rides the EXISTING extractor call** — `defaultExtractor`'s forced-tool
  schema gains optional money fields; no second model call per note.
- **Weekly reconciliation digest** — reconciliation is a ritual, not a stream of corrections: one
  weekly message listing the week's ledger entries + open money questions; silent when there is
  nothing to say. Cadence via a new `tenants.money_digest_last_sent_at` column (see Phase 3 for
  why NOT `ops_events`). Immediate disclosure still accompanies every Class 2 auto-record (undo
  latency beats batching at realistic volumes).
- **Four precision gates, all code-side** (details in Phase 1): grounding (the amount string
  must occur verbatim in the capture text — the model identifies, never invents); deterministic
  attribution (recipient → unique customer → **exactly one** open job; multiple open jobs ⇒
  suggestion — "most recent" would auto-land an older job's invoice on the newer; review
  finding); fresh-appends-only (deduped re-scan rows never re-infer, so a DISMISSED suggestion
  stays dismissed — the review-items unique index is open-rows-only; accepted gap: a crash
  between append and inference loses it, the quiet-job nudge is the net); second-invoice guard
  (an `invoice_issued` inference on an already-invoiced job ⇒ suggestion — covers the sweep's
  message-id parse-failure corner AND real re-sends; review finding).
- **The swept send capture gains `metadata.to`** (it stores no recipient today, making
  attribution impossible) — a recorded redaction-policy extension; sends are full-value
  captures by the 2026-07-04 exception.
- **Inferred-event dedupe is content-keyed** — `dedupe_key = money:<jobId>:<kind>:<amountCents>:
  <firm-local date>`. Residual risk (two identical same-day invoices, one job) accepted;
  manual entries pass `dedupe_key: null`, never blocked.
- **Ask-when-unsure, once** — ONE `money_event_suggestion` per capture; ONE `job_done_check` per
  job; batched notifications. Ask-behavior tuning via scenario evals/RL: deferred.
- **Mis-inference is fully undoable** — a void/correction reverses both the number and the
  status walk (part A's bidirectional sync); every disclosure says so.

## Plain-language walkthrough

**Phase 1 — email inference, tiered.** When an invoice-looking email leaves through the manager's
connected Gmail or the spine's send tool, the system reads the already-captured body, extracts
the amount (which must literally appear in the text), and matches the recipient to exactly one
customer and job. Because the manager wrote the email themselves (Class 2), a confident match
auto-records and the manager is told immediately — including how to undo. Anything short of
confident — ungrounded amount, ambiguous recipient, or an amount over the $10k cap — becomes one
question instead of a ledger row.

```
outbound email (manager-authored = Class 2)
  └► infer ─► ground-check ─► attribute ─► under cap? ──► record + disclose ("undo with a correction")
                   │              │            │
                   └──────────────┴────────────┴─ any doubt ──► ONE suggestion review item (no write)

field note "collected $200 cash" (Class 3)
  └► extractor money fields ─► ground-check ─► ALWAYS a suggestion ─► manager confirms ─► recorded
```

**Phase 2 — notes as a source; reads that cite their evidence.** Field notes are where cash
lives; a money mention in a note becomes a suggestion for the manager (never a direct write —
the note already names its job, so the question is precise). Money reads gain provenance so the
agent can say "based on the invoice email you sent Tuesday" instead of asserting a balance.

**Phase 3 — the rhythm.** A scheduled check asks about jobs that look finished with no money
trail (one question per job, batched). A weekly digest lists what entered the ledger and what
questions are open — reconciliation as a ritual. Firm-facing docs disclose money tracking and
inference honestly, including the blind spot: cash/checks only appear if someone mentions them.

## Secrets & env preflight

- **Phase 1:** `INFERENCE_API_KEY` (`already required` — extractor provider); `COMPOSIO_API_KEY`
  (`already required`, live sweep only — tests mock).
- **Phase 2:** none new.
- **Phase 3:** `TELEGRAM_BOT_TOKEN` (`already required`, notify path — tests mock).

## Phase 1: Tiered inference from outbound email

### What this phase does
Class-2 money events are inferred from already-captured outbound email, code-validated,
capped, evidence-linked, idempotent; every doubt becomes a suggestion instead of a row.

### Changes required

**`src/money/inferMoneyEvent.ts`** (new)
- `inferMoneyEvent(rawText, ctx)` via `src/model/forcedTool.ts` (extractor precedent,
  [extract.ts:84-92](src/writePath/extract.ts#L84-L92)): forced tool returning `{kind:
  'invoice_issued'|'payment_received'|'estimate_presented'|'none', amountDollarsText,
  externalRef?, progress?}`. Prompt: identify only, never invent.
- Code-side grounding: parse `amountDollarsText` → cents; require the literal string in
  `rawText` (whitespace/comma-tolerant); failure ⇒ `{grounded: false}`.
- `attributeCaptureToJob(tenantId, capture)`: deterministic — `metadata.to` → unique customer
  via new `findCustomersByEmail` → EXACTLY ONE non-terminal job; zero/multiple customers OR
  multiple open jobs ⇒ ambiguous (with which reason).

**`src/db/customers.ts`** — `findCustomersByEmail(tenantId, email)`: case-insensitive EQUALITY —
NOT the bare-ilike idiom (`_` in a local part is an ilike wildcard; `john_doe@…` could uniquely
match the WRONG customer and auto-record on their job — review finding). Escape `%`/`_`/`\`
before `ilike`; test pins the `_` case.

**`src/money/applyInference.ts`** (new)
- `MONEY_AUTO_RECORD_CAP_CENTS = 1_000_000` (exported, documented).
- `applyMoneyInference(tenantId, capture, { evidenceClass })` — class is a CALL-SITE parameter,
  never detected. First, skip any capture stamped `metadata.invoiceNumber` (Class 1 — part C
  records its own event synchronously). Then:
  - Class 2 + grounded + unambiguous + `amountCents <= cap` + second-invoice guard passes
    (no live non-negated `invoice_issued` already on the job, for `invoice_issued` inferences)
    ⇒ `appendMoneyEvent` (`source_capture_id` = capture id, `actor_ref:
    'inference:outbound_email'`, content-keyed `dedupe_key`, firm-local date via
    `tenants.timezone`; swallow dedupe collision) → `syncJobStatusForMoney` → `notifyManagers`
    one line: what was recorded, from which email, and that a correction/void undoes number
    AND status.
  - Anything else (incl. all Class 3) ⇒ `upsertOpenReviewItem` kind `money_event_suggestion`,
    `subject_ref` = capture id (once-per-OPEN-capture via the partial unique index), detail =
    inferred fields + jobId when attributed + reason (`ungrounded` / `ambiguous` /
    `multiple_jobs` / `over_cap` / `second_invoice` / `class3`). Errors logged, never thrown
    into the send path.

**`src/mcp/server.ts`** — `send_email` success path, after the L1 append (keep
`appendRawCapture`'s RETURN — currently discarded; inference needs the capture id): call
`applyMoneyInference` with **evidenceClass by caller tier** — active manager ⇒ 2, technician ⇒
3 (review finding: `requireOutboundCapable` checks paired+active only, not tier — a
technician-authored email must never auto-write the ledger). Failures only annotate the reply
(a capture/inference failure never un-reports a real send — existing rule).

**`src/composio/logIngest.ts`** — send shape ([logIngest.ts:243-266](src/composio/logIngest.ts#L243-L266)):
(a) add the recipient to the swept capture's `metadata.to` from `args.recipient_email` (the
Composio send-arg name; `GMAIL_REPLY_TO_THREAD` may carry none — that degrades to a suggestion,
expected in tests), extending the redaction-policy comment
([logIngest.ts:254-258](src/composio/logIngest.ts#L254-L258)) with this reviewed entry; (b) call
`applyMoneyInference(…, { evidenceClass: 2 })` **only when the append was FRESH** (the ingest
already distinguishes `deduped` — the 60-min overlap re-scan is absorbed at L1, per the
Decisions bullet; the sweep structurally skips technician sends, so Class 2 is correct here).

**`src/db/reviewItems.ts`** — add `'money_event_suggestion'` to `ReviewKind` (non-token: resolve
= manager records via `record_money_event`; dismiss = not money). Verify it stays out of the
staged-action set — NOTE: that lives as a local map in `server.ts`'s `resolve_review` handler,
not in `reviewItems.ts`.

### Automated verification
- [ ] Gates pass. `inferMoneyEvent` (mocked model): invoice email → grounded; amount not in
  text → ungrounded; non-money email → null
- [ ] `applyInference` (local stack): Class-2 unique match under cap appends + syncs + notifies
  (notify mocked); over-cap → suggestion, NO row; ambiguous/ungrounded/multiple-open-jobs →
  one suggestion each, idempotent across re-runs; `evidenceClass: 3` NEVER appends even when
  grounded+unambiguous; second-invoice guard: a second invoice inference on an already-invoiced
  job → suggestion, not a row; dedupe collapses spine+sweep double capture to one event;
  voiding an inferred invoice walks the job back `invoiced → completed`
- [ ] Tier gate at the spine send site: a TECHNICIAN send producing an invoice-looking email →
  suggestion, never an auto-record
- [ ] `findCustomersByEmail`: underscore in the local part must NOT wildcard-match a different
  customer
- [ ] `logIngest.test.ts` extended: swept invoice email carries `metadata.to` (from
  `recipient_email`) and produces the event (model mocked); a DEDUPED re-scan row triggers NO
  inference; dismiss-then-rescan: a dismissed suggestion is not re-created; a reply-to-thread
  send with no recipient degrades to a suggestion

### Live verification (agent-executable)
- Prerequisites: local stack + `INFERENCE_API_KEY` in `.env` (key-gated skip idiom).
- [ ] One live-model run over a realistic invoice-email fixture → evidence: extracted amount,
  grounding pass, ledger row via psql read-back.

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 2: Notes as a Class-3 source; reads that cite their evidence

### What this phase does
Money mentions in field notes become precise suggestions (cash's only path in); money reads
carry provenance and the phrasing doctrine.

### Changes required

**`src/writePath/extract.ts`** — extend the forced-tool schema with optional
`moneySignal: {kind, amountDollarsText}` (same vocabulary as `inferMoneyEvent`; absent unless the
note states money). ONE model call per note, unchanged count.

**`src/writePath/recordFieldNote.ts`** — after the L2 build, when `moneySignal` present:
code-side ground-check against the note text, then ALWAYS
`applyMoneyInference(…, { evidenceClass: 3 })`-style suggestion (subject_ref = capture id,
detail includes the note's resolved jobId — attribution is free here). Suggestion text names
job + amount + who said it ("Ben's note says he collected $200 cash on the Henderson job —
record it?"). Never a direct ledger write (tier policy).

**`src/mcp/server.ts`** — money-read provenance + phrasing:
- `get_job` (manager branch): each `recentEvents` entry gains `actorRef` and
  `evidence: 'manager' | 'spine' | 'inferred'` (derived from money_events columns only:
  `actor_ref` prefix `inference:` ⇒ inferred; `detail.invoiceId` present ⇒ spine — the invoice
  plan stamps the EVENT with `detail.invoiceId` and the CAPTURE with `metadata.invoiceNumber`;
  money_events has no metadata column, so no capture read is needed; else manager).
- Description text on `get_job` + `get_customer_context` + `record_money_event` reply note:
  attribute money figures to their evidence when relaying; say "no payment on record", never
  "they owe" when payment channels are known-blind; the summary is what the LEDGER shows, not
  the firm's books.

### Automated verification
- [ ] Gates pass. recordFieldNote test: money note → ONE suggestion with the right jobId, no
  ledger row, idempotent on redelivery; moneyless note → nothing
- [ ] server.test.ts: recentEvents carries actorRef/evidence for a manager entry vs an inferred
  entry (fixture with `actor_ref: 'inference:outbound_email'`)

### Live verification (agent-executable)
- Prerequisites: local stack.
- [ ] Maker≠checker subagent: real note through the MCP server → suggestion review item via psql
  read-back; evidence: item detail names the job and grounded amount.

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 3: Probably-done nudge + weekly digest + docs/disclosure

### What this phase does
The heartbeat asks about finished-looking jobs with no money trail; a weekly digest makes
reconciliation a ritual; firm-facing docs disclose money tracking, inference, and the blind spot.

### Changes required

**`supabase/migrations/<ts>_money_digest_cadence.sql`** (new) —
`alter table tenants add column money_digest_last_sent_at timestamptz;` + regen types. (Review
blocker: `ops_events` cannot host this — host-scoped FK + one-open-per-service index. A
settings-style tenant column is the `technician_horizon_days` precedent.)

**`src/db/tenants.ts`** — `setMoneyDigestSentAt(tenantId, iso)` (plain update, single-writer —
the lifecycle is the only caller).

**`src/jobs/lifecycle.ts`** — two steps after the logIngest sweep, iterating tenants via
`listTenantSeats()` (the existing enumerator):
- *Nudge:* per tenant, quiet open jobs → `upsertOpenReviewItem` kind `job_done_check`
  (`subject_ref` = jobId; phrased about the JOB, never a visit). ONE batched `notifyManagers`
  message. Auto-dismiss items whose job left `open|in_progress`. `DONE_CHECK_QUIET_DAYS = 3`.
- *Digest:* per tenant, if `money_digest_last_sent_at` is null-or-older-than 7 days AND (money
  events with `created_at > last_sent` OR open money suggestions/done-checks): ONE message
  listing the period's ledger entries (kind, amount, evidence) + open questions; then
  `setMoneyDigestSentAt(now)`. Silent when empty — no noise weeks.

**`src/db/assignments.ts`** — `listQuietOpenJobs(tenantId, cutoffs)` (anti-join shape).
"Quiet" must cover assignment-less jobs (note-only jobs create `visits`, never assignments):
newest activity = max(newest confirmed assignment `ends_at`, newest visit `created_at`, job
`created_at`) < cutoff, AND no upcoming/unplaced assignment, AND no `invoice_issued` event.
**TWO cutoffs** `{ naiveLocalCutoff, utcCutoff }` from the same firm-local moment (review
finding: assignment times are naive-local by convention, `created_at` columns are true UTC —
one shared cutoff is off by the firm's whole UTC offset); compare each column per its
convention.

**`src/db/reviewItems.ts`** — add `'job_done_check'` (non-token; resolve = done → suggestion
text points at `record_money_event`; dismiss = still going).

**Docs** — [docs/customer-onboarding-runbook.md:264-265](docs/customer-onboarding-runbook.md#L264-L265)
and [docs/getting-started-for-firms.md:406-407](docs/getting-started-for-firms.md#L406-L407):
replace "No invoicing, payments, pricing…" with: money *tracking* exists (ledger + balance),
still **no** payment processing; disclosure: money events may be inferred from emails sent
through connected accounts, and the assistant may ask about money mentioned in job notes; blind
spot stated honestly (cash/checks appear only when mentioned).
`docs/Three-Layer-Context-Spine-Overview.md`: short dated amendment.
`docs/engineering-memory.md`: live-state entry for ledger + tiered inference.

### Automated verification
- [ ] Gates pass. Lifecycle: quiet uninvoiced job → one item, idempotent; invoiced → none;
  assignment-less quiet job → item; auto-dismiss on completion. Digest: events-since-last →
  one message + `money_digest_last_sent_at` updated; nothing new → silent; 7-day gate via the
  column (null = first run sends when there is content)
- [ ] `listQuietOpenJobs` boundary tests (2.9 vs 3.1 days), exercised PER LEG — an
  assignment-quiet case and a created_at-quiet case each near the boundary, so a single-cutoff
  regression fails; unplaced-visit jobs excluded

### Live verification (agent-executable)
- Prerequisites: local stack.
- [ ] `npm run job:lifecycle` against seeded data (maker≠checker) → evidence: review items +
  the batched nudge payload + the digest payload (notify captured via mock/log).

### Manual verification
- [ ] Read the nudge, disclosure, and digest texts as a manager would: job-vs-visit wording
  unambiguous? Does the digest read as "here to reconcile", not "here to correct you"? Is the
  docs disclosure honest and plain?

---
*Pause after Phase 3 for the manual wording check.*
